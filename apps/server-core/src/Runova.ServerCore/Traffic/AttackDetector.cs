using System.Net;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Traffic;

/// <summary>
/// One request that is part of an attack. Count is how many requests it stands for: the whole
/// window on the request that crossed the threshold, then one each. A site-wide flood names every
/// address in it, but none of them alone was over the rate, so auto-block leaves them alone.
/// Address is who the attack is counted under: an IPv4 address, or the first address of an IPv6
/// /64 (<see cref="IpKey.Visitor"/>).
/// </summary>
internal readonly record struct AttackHit(string Site, AttackKind Kind, IpKey Address, long AtUnixMs, string Path, string? Country, int Count, bool SiteWide);

/// <summary>
/// Spots attacks in a site's requests (E110), like <see cref="Alerts.CrashLoopDetector"/> does for
/// containers: pure, fed by one loop, counting in sliding windows per site and visitor (an IPv4
/// address, or an IPv6 /64, so moving around inside one counts as the same visitor). Scans are
/// probe paths or many 404s; brute force is POSTs to login pages; floods are one address over a rate,
/// or a site at ten times its usual rate; injection is SQL, script, traversal, command or Log4Shell
/// patterns in the decoded path, query or user agent. An address is flagged once a window reaches
/// its threshold and stays flagged while the window holds anything. Private, loopback and link-local
/// addresses, the allowlist and Cloudflare's own addresses are never counted. At most
/// <c>capacity</c> addresses are followed; past that the one quiet longest is forgotten. Times are
/// the log lines' own.
/// </summary>
internal sealed class AttackDetector
{
    public const int DefaultCapacity = 50_000;

    /// <summary>Paths no ordinary visitor asks for (lowercase): anywhere in the path.</summary>
    private static readonly string[] _probesAnywhere =
    [
        "/.env", "/.git", "/.svn", "/.hg/", "/.aws/", "/.ssh/", "/.htpasswd", "/.ds_store", "/.vscode/", "/.npmrc",
        "/.bash_history", "/id_rsa", "wp-config.php", "/phpunit/", "phpmyadmin", "phpinfo.php", "/.docker", "docker-compose.y",
        "/sftp-config.json", ".sql.gz", "/dump.sql", "/database.sql", "/backup.zip", "/backup.tar",
    ];

    /// <summary>Paths no ordinary visitor asks for (lowercase): at the start.</summary>
    private static readonly string[] _probesAtStart =
    [
        "/server-status", "/server-info", "/actuator", "/cgi-bin/", "/pma/", "/myadmin", "/hnap1", "/boaform", "/solr/admin",
        "/manager/html", "/owa/", "/autodiscover/autodiscover.xml", "/druid/", "/telescope", "/_profiler", "/debug/default/view",
        "/console/", "/shell", "/wso.php", "/info.php", "/config.json", "/web.config", "/.well-known/acme-challenge/../",
    ];

    /// <summary>Login pages (lowercase): the path is one of these, or one of these and then /, . or more of a name after a slash.</summary>
    private static readonly string[] _logins =
    [
        "/wp-login.php", "/xmlrpc.php", "/login", "/signin", "/sign-in", "/log-in", "/user/login", "/users/sign_in", "/admin",
        "/administrator", "/api/auth", "/api/login", "/auth/login", "/account/login", "/accounts/login", "/session", "/sessions",
        "/wp-admin", "/j_security_check", "/admin/login", "/user/signin",
    ];

    /// <summary>Injection patterns in the decoded, lowercase path and query.</summary>
    private static readonly string[] _injections =
    [
        // SQL injection.
        "union select", "union all select", "' or '1'='1", "' or 1=1", "\" or 1=1", " or 1=1", "' or '1", "sleep(", "benchmark(",
        "waitfor delay", "information_schema", "load_file(", "into outfile", "xp_cmdshell", "@@version", "pg_sleep", "extractvalue(",
        "updatexml(", "select * from", "drop table", "' and '1'='1", "order by 1--",
        // Cross-site scripting.
        "<script", "javascript:", "onerror=", "onload=", "<svg", "<iframe", "document.cookie", "alert(", "<img src", "prompt(",
        // Path traversal.
        "../", "..\\", "/etc/passwd", "/etc/shadow", "c:\\windows", "win.ini", "boot.ini", "/proc/self/",
        // Command injection.
        "$(", "`", ";cat ", "|cat ", "; cat ", ";wget", "|wget", "; wget", ";curl", "|curl", "; curl", "/bin/sh", "/bin/bash", "cmd.exe",
        "powershell", "nc -e", ";id;", "|id;", "&&id", ";ls ", "; ls", "|ls ",
        // Log4Shell.
        "${jndi:", "${${", "${lower:", "${upper:", "${env:", "${::-",
    ];

    private const long MinuteMs = 60_000;

    /// <summary>A site needs an hour of history before its usual rate means anything.</summary>
    private const int BaselineMinutes = 60;

    private const int SiteFloodFactor = 10;

    private readonly AttackThresholds _thresholds;
    private readonly IpNetwork[] _allowlist;
    private readonly IpNetwork[] _neverFlag;
    private readonly int _capacity;
    private readonly Dictionary<(string Site, IpKey Address), LinkedListNode<Follow>> _tracked = [];
    private readonly LinkedList<Follow> _order = new();
    private readonly Dictionary<string, SiteRate> _sites = new(StringComparer.Ordinal);

    public AttackDetector(AttackThresholds thresholds, IEnumerable<IpNetwork> allowlist, IEnumerable<IpNetwork>? neverFlag = null, int capacity = DefaultCapacity)
    {
        ArgumentNullException.ThrowIfNull(thresholds);
        ArgumentNullException.ThrowIfNull(allowlist);
        _thresholds = thresholds;
        _allowlist = [.. allowlist];
        _neverFlag = [.. neverFlag ?? GeoCountry.CloudflareDefaults.Select(text => IpNetwork.TryParse(text, out var network) ? network : default)];
        _capacity = capacity;
    }

    public int Tracked => _tracked.Count;

    /// <summary>Whether the address is ever counted: not local, not allowed, not Cloudflare.</summary>
    public bool Watches(IpKey address)
    {
        if (address.IsLocal)
        {
            return false;
        }

        foreach (var network in _allowlist)
        {
            if (network.Contains(address))
            {
                return false;
            }
        }

        foreach (var network in _neverFlag)
        {
            if (network.Prefix > 0 && network.Contains(address))
            {
                return false;
            }
        }

        return true;
    }

    public void Observe(in TrafficRequest request, List<AttackHit> hits)
    {
        ArgumentNullException.ThrowIfNull(hits);
        if (!Watches(request.Address))
        {
            return;
        }

        var at = request.AtUnixMs;
        var visitor = request.Address.Visitor.Base;
        var tracked = TrackedOf(request.Site, visitor);
        var path = Shown(request);

        var probe = IsProbe(request.Path);
        var notFound = request.Status == 404;
        if (probe || notFound)
        {
            var window = Minutes(_thresholds.ScanWindowMinutes);
            tracked.Probes ??= new SlidingCount(window);
            tracked.NotFound ??= new SlidingCount(window);
            var probes = probe ? tracked.Probes.Add(at) : tracked.Probes.Count(at);
            var misses = notFound ? tracked.NotFound.Add(at) : tracked.NotFound.Count(at);
            Check(ref tracked.Scan, AttackKind.Scan, probes >= _thresholds.ScanProbes || misses >= _thresholds.ScanNotFound, Math.Max(probes, misses), request, visitor, path, hits);
        }

        if (request.Method == TrafficMethod.Post && IsLogin(request.Path))
        {
            tracked.Logins ??= new SlidingCount(Minutes(_thresholds.BruteForceWindowMinutes));
            var attempts = tracked.Logins.Add(at);
            Check(ref tracked.BruteForce, AttackKind.BruteForce, attempts >= _thresholds.BruteForceAttempts, attempts, request, visitor, path, hits);
        }

        if (request.SuspiciousAgent || LooksLikeInjection(request.Path, request.Query))
        {
            tracked.Injections ??= new SlidingCount(Minutes(_thresholds.InjectionWindowMinutes));
            var injections = tracked.Injections.Add(at);
            Check(ref tracked.Injection, AttackKind.Injection, injections >= _thresholds.InjectionHits, injections, request, visitor, path, hits);
        }

        tracked.Requests ??= new SlidingCount(MinuteMs);
        var rate = tracked.Requests.Add(at);
        var flooding = Check(ref tracked.Flood, AttackKind.Flood, rate >= _thresholds.FloodRequestsPerMinute, rate, request, visitor, path, hits);
        if (!flooding && SiteFlooding(request.Site, at))
        {
            hits.Add(new AttackHit(request.Site, AttackKind.Flood, visitor, at, path, request.Geo.Country, 1, SiteWide: true));
        }
    }

    /// <summary>Whether a path or query carries an injection pattern, after percent-decoding twice.</summary>
    public static bool LooksLikeInjection(string path, string? query)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (query is null && !NeedsLook(path))
        {
            return false;
        }

        var text = Decode(Decode(query is null ? path : path + "?" + query.Replace('+', ' '))).ToLowerInvariant().Replace("/**/", " ", StringComparison.Ordinal);
        foreach (var pattern in _injections)
        {
            if (text.Contains(pattern, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    public static bool IsProbe(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        foreach (var probe in _probesAnywhere)
        {
            if (path.Contains(probe, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        foreach (var probe in _probesAtStart)
        {
            if (path.StartsWith(probe, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    public static bool IsLogin(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        foreach (var login in _logins)
        {
            if (path.StartsWith(login, StringComparison.OrdinalIgnoreCase)
                && (path.Length == login.Length || path[login.Length] is '/' or '.' || login == "/api/auth"))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Raises the hit when the address crosses the threshold, or is still flagged. True while flagged.</summary>
    private static bool Check(ref bool flagged, AttackKind kind, bool over, int count, in TrafficRequest request, IpKey visitor, string path, List<AttackHit> hits)
    {
        if (!flagged && !over)
        {
            return false;
        }

        hits.Add(new AttackHit(request.Site, kind, visitor, request.AtUnixMs, path, request.Geo.Country, flagged ? 1 : count, SiteWide: false));
        flagged = true;
        return true;
    }

    /// <summary>The site's requests this minute against ten times its average over the hour before.</summary>
    private bool SiteFlooding(string site, long at)
    {
        if (!_sites.TryGetValue(site, out var rate))
        {
            rate = new SiteRate(at / MinuteMs);
            _sites[site] = rate;
        }

        var minute = at / MinuteMs;
        var now = rate.Add(minute);
        if (minute - rate.FirstMinute < BaselineMinutes)
        {
            return false;
        }

        var baseline = rate.Before(minute, BaselineMinutes) / (double)BaselineMinutes;
        return now >= Math.Max(SiteFloodFactor * baseline, _thresholds.FloodRequestsPerMinute);
    }

    private Follow TrackedOf(string site, IpKey address)
    {
        if (_tracked.TryGetValue((site, address), out var node))
        {
            _order.Remove(node);
            _order.AddLast(node);
            node.Value.Expire();
            return node.Value;
        }

        if (_tracked.Count >= _capacity && _order.First is { } oldest)
        {
            _order.RemoveFirst();
            _tracked.Remove((oldest.Value.Site, oldest.Value.Address));
        }

        var tracked = new Follow(site, address);
        _tracked[(site, address)] = _order.AddLast(tracked);
        return tracked;
    }

    private static long Minutes(int minutes) => Math.Max(1, minutes) * MinuteMs;

    private static string Shown(in TrafficRequest request) =>
        TrafficSites.Clip(request.Query is null ? request.Path : request.Path + "?" + request.Query);

    /// <summary>Plain paths of letters, digits, dashes, dots and slashes cannot carry any pattern above.</summary>
    private static bool NeedsLook(string path)
    {
        foreach (var c in path)
        {
            if (!(char.IsAsciiLetterOrDigit(c) || c is '/' or '-' or '_' or '.' or '~'))
            {
                return true;
            }
        }

        return path.Contains("..", StringComparison.Ordinal);
    }

    private static string Decode(string text) => text.Contains('%', StringComparison.Ordinal) ? WebUtility.UrlDecode(text.Replace("+", "%2B", StringComparison.Ordinal)) : text;

    /// <summary>What is followed for one visitor on one site.</summary>
    private sealed class Follow(string site, IpKey address)
    {
        public string Site { get; } = site;

        public IpKey Address { get; } = address;

        public SlidingCount? Probes { get; set; }

        public SlidingCount? NotFound { get; set; }

        public SlidingCount? Logins { get; set; }

        public SlidingCount? Injections { get; set; }

        public SlidingCount? Requests { get; set; }

        // Fields, so Check can set them through a ref.
        public bool Scan;

        public bool BruteForce;

        public bool Injection;

        public bool Flood;

        /// <summary>A flag lasts while its window holds anything.</summary>
        public void Expire()
        {
            Scan &= (Probes?.Any ?? false) || (NotFound?.Any ?? false);
            BruteForce &= Logins?.Any ?? false;
            Injection &= Injections?.Any ?? false;
            Flood &= Requests?.Any ?? false;
        }
    }

    /// <summary>
    /// Events in a sliding window, counted in ten buckets, so memory stays the same however many
    /// there are. The count is exact to a tenth of the window.
    /// </summary>
    private sealed class SlidingCount(long windowMs)
    {
        private const int Slots = 10;

        private readonly long[] _starts = new long[Slots];
        private readonly int[] _counts = new int[Slots];
        private readonly long _slotMs = Math.Max(1, windowMs / Slots);
        private long _latest;

        public bool Any => Count(_latest) > 0;

        public int Add(long at)
        {
            var start = at - (at % _slotMs);
            var slot = (int)(start / _slotMs % Slots);
            if (_starts[slot] != start)
            {
                _starts[slot] = start;
                _counts[slot] = 0;
            }

            _counts[slot]++;
            _latest = Math.Max(_latest, at);
            return Count(at);
        }

        public int Count(long at)
        {
            var oldest = at - (at % _slotMs) - ((Slots - 1) * _slotMs);
            var total = 0;
            for (var i = 0; i < Slots; i++)
            {
                if (_starts[i] >= oldest && _starts[i] <= at)
                {
                    total += _counts[i];
                }
            }

            return total;
        }
    }

    /// <summary>A site's requests per minute over the last hour and a bit, in a ring of minutes.</summary>
    private sealed class SiteRate(long firstMinute)
    {
        private const int Ring = BaselineMinutes + 2;

        private readonly long[] _minutes = new long[Ring];
        private readonly int[] _counts = new int[Ring];

        public long FirstMinute { get; } = firstMinute;

        public int Add(long minute)
        {
            var slot = (int)(minute % Ring);
            if (_minutes[slot] != minute)
            {
                _minutes[slot] = minute;
                _counts[slot] = 0;
            }

            return ++_counts[slot];
        }

        /// <summary>Requests in the minutes before this one.</summary>
        public long Before(long minute, int minutes)
        {
            long total = 0;
            for (var i = 0; i < Ring; i++)
            {
                if (_minutes[i] < minute && _minutes[i] >= minute - minutes)
                {
                    total += _counts[i];
                }
            }

            return total;
        }
    }
}
