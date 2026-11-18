using System.IO.Compression;
using System.Text;
using MaxMind.Db;

namespace Runova.ServerCore.Traffic;

internal enum CountrySource
{
    None,
    Cloudflare,
    DbIp,
}

/// <summary>Where a visitor is: an ISO country code (T1 for Tor, XX when unknown), and the city and region when Cloudflare tells.</summary>
internal readonly record struct GeoResult(string Country, CountrySource Source, string? City, string? Region);

/// <summary>A country file: the ISO code of the country an address is in, or null.</summary>
internal interface IGeoDatabase
{
    string? Country(IpKey key);
}

/// <summary>
/// Places visitors in countries (E109). Cloudflare's CF-IPCountry header is used only when the
/// request came from Cloudflare's networks or through the tunnel's listener (whose only client is
/// cloudflared on loopback), so a request straight to the server cannot choose its country. Every
/// other visitor is looked up in DB-IP's country file, with an LRU of addresses in front. Codes are
/// shared strings, so a line costs no allocation for them.
/// </summary>
internal sealed class GeoCountry
{
    public const string Unknown = "XX";

    public const string Tor = "T1";

    public const int CacheSize = 16_384;

    /// <summary>
    /// Cloudflare's published ranges (cloudflare.com/ips), used until the core has fetched them
    /// itself for the origin lock (E14).
    /// </summary>
    public static readonly IReadOnlyList<string> CloudflareDefaults =
    [
        "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
        "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
        "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
        "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
    ];

    private static readonly string?[] _codes = new string?[26 * 26];

    private readonly LruCache<IpKey, string?> _cache = new(CacheSize);

    private volatile IGeoDatabase? _database;

    private volatile IpNetwork[] _cloudflare = Networks(CloudflareDefaults);

    public bool Ready => _database is not null;

    public IGeoDatabase? Database => _database;

    /// <summary>Swaps the country file in whole; lookups already running finish on the old one.</summary>
    public void UseDatabase(IGeoDatabase? database)
    {
        var old = _database;
        _database = database;
        _cache.Clear();
        if (!ReferenceEquals(old, database) && old is IDisposable disposable)
        {
            disposable.Dispose();
        }
    }

    public void TrustCloudflare(IEnumerable<string> networks)
    {
        ArgumentNullException.ThrowIfNull(networks);
        _cloudflare = Networks(networks);
    }

    /// <summary>Whether the address that connected is Cloudflare (or cloudflared on loopback), so its headers may be believed.</summary>
    public bool IsCloudflare(IpKey connecting)
    {
        if (connecting.IsV4 ? (uint)connecting.Value >> 24 == 127 : connecting.Value == UInt128.One)
        {
            return true;
        }

        foreach (var network in _cloudflare)
        {
            if (network.Contains(connecting))
            {
                return true;
            }
        }

        return false;
    }

    public GeoResult Locate(in AccessLogLine line, IpKey visitor)
    {
        if (line.Extended && IpKey.TryParse(line.ConnectingAddress, out var connecting) && IsCloudflare(connecting)
            && Code(line.CloudflareCountry) is { } header && header != Unknown)
        {
            return new GeoResult(
                header,
                CountrySource.Cloudflare,
                line.CloudflareCity.IsEmpty ? null : AccessLogParser.Text(line.CloudflareCity),
                line.CloudflareRegion.IsEmpty ? null : AccessLogParser.Text(line.CloudflareRegion));
        }

        return Lookup(visitor) is { } country
            ? new GeoResult(country, CountrySource.DbIp, null, null)
            : new GeoResult(Unknown, CountrySource.None, null, null);
    }

    /// <summary>The country DB-IP gives the address, or null.</summary>
    public string? Lookup(IpKey address)
    {
        if (_database is not { } database || address.IsLocal)
        {
            return null;
        }

        if (_cache.TryGet(address, out var known))
        {
            return known;
        }

        var found = database.Country(address) is { Length: 2 } code ? Code(Encoding.ASCII.GetBytes(code)) : null;
        _cache.Set(address, found);
        return found;
    }

    /// <summary>Two ASCII letters as the one shared upper-case string for them; anything else is null.</summary>
    public static string? Code(ReadOnlySpan<byte> text)
    {
        if (text.Length != 2 || !char.IsAsciiLetter((char)text[0]) || !(char.IsAsciiLetter((char)text[1]) || text[1] == (byte)'1'))
        {
            return null;
        }

        var first = char.ToUpperInvariant((char)text[0]);
        var second = char.ToUpperInvariant((char)text[1]);
        if (second == '1')
        {
            return first == 'T' ? Tor : null;
        }

        var index = ((first - 'A') * 26) + (second - 'A');
        return _codes[index] ??= string.Concat(first.ToString(), second.ToString());
    }

    private static IpNetwork[] Networks(IEnumerable<string> networks) =>
        [.. networks.Select(text => IpNetwork.TryParse(text, out var network) ? network : (IpNetwork?)null).OfType<IpNetwork>()];
}

/// <summary>DB-IP's (or any MaxMind-format) country file, read into memory with MaxMind's reader.</summary>
internal sealed class MmdbCountryDatabase : IGeoDatabase, IDisposable
{
    private readonly Reader _reader;

    private MmdbCountryDatabase(Reader reader) => _reader = reader;

    public string DatabaseType => _reader.Metadata.DatabaseType;

    /// <summary>Opens and checks the file; throws when it is not a country file.</summary>
    public static MmdbCountryDatabase Open(string path)
    {
        var reader = new Reader(path, FileAccessMode.Memory);
        try
        {
            if (!reader.Metadata.DatabaseType.Contains("Country", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException($"The file is a {reader.Metadata.DatabaseType} database, not a country one.");
            }

            return new MmdbCountryDatabase(reader);
        }
        catch
        {
            reader.Dispose();
            throw;
        }
    }

    public string? Country(IpKey key)
    {
        if (!key.IsV4 && _reader.Metadata.IPVersion == 4)
        {
            return null;
        }

        try
        {
            return _reader.Find<MmdbCountryRecord>(key.ToAddress())?.Country?.IsoCode;
        }
        catch (InvalidDatabaseException)
        {
            return null;
        }
    }

    public void Dispose() => _reader.Dispose();
}

/// <summary>The part of a country file's record the core reads: country.iso_code.</summary>
internal sealed class MmdbCountryRecord
{
    [Constructor]
    public MmdbCountryRecord([MapKey("country")] MmdbCountry? country = null) => Country = country;

    public MmdbCountry? Country { get; }
}

internal sealed class MmdbCountry
{
    [Constructor]
    public MmdbCountry([MapKey("iso_code")] string? isoCode = null) => IsoCode = isoCode;

    public string? IsoCode { get; }
}

/// <summary>How DB-IP's country file stands. Problem says in words why the latest download did not take.</summary>
internal sealed record GeoDatabaseState(bool Ready, long? UpdatedAtUnixMs = null, string? Problem = null);

/// <summary>
/// Keeps DB-IP's free country file (CC BY 4.0) in the core's data folder: once a month it downloads
/// dbip-country-lite-YYYY-MM.mmdb.gz, unpacks it beside the old one, opens it to check it, and only
/// then moves it over the old file and swaps it in. Early in a month, before DB-IP publishes the new
/// file, the month before is used. A download that fails or is not a country file changes nothing.
/// </summary>
internal sealed partial class GeoDatabaseUpdater(HttpMessageHandler handler, string folder, GeoCountry geo, TimeProvider time, ILogger<GeoDatabaseUpdater> logger) : IDisposable
{
    public const string FileName = "dbip-country-lite.mmdb";

    public const string UrlStart = "https://download.db-ip.com/free/dbip-country-lite-";

    /// <summary>The country file is about 8 MB unpacked; anything far past that is not it.</summary>
    public const long MaxDownloadBytes = 64L * 1024 * 1024;

    public const long MaxFileBytes = 256L * 1024 * 1024;

    private const string MonthFile = "dbip-country-lite.month";

    private readonly SemaphoreSlim _gate = new(1, 1);

    private string? _problem;

    public void Dispose() => _gate.Dispose();

    /// <summary>The month of the file in use, as yyyy-MM, or null when there is none.</summary>
    public string? Month { get; private set; }

    public string FilePath => Path.Combine(folder, FileName);

    public GeoDatabaseState State => new(
        geo.Ready,
        File.Exists(FilePath) ? new DateTimeOffset(File.GetLastWriteTimeUtc(FilePath), TimeSpan.Zero).ToUnixTimeMilliseconds() : null,
        _problem);

    /// <summary>The file already in the data folder, when there is one that opens.</summary>
    public void LoadExisting()
    {
        if (!File.Exists(FilePath))
        {
            return;
        }

        try
        {
            geo.UseDatabase(MmdbCountryDatabase.Open(FilePath));
            var month = Path.Combine(folder, MonthFile);
            Month = File.Exists(month) ? File.ReadAllText(month).Trim() : null;
        }
        catch (Exception error) when (error is IOException or InvalidDataException or InvalidDatabaseException or UnauthorizedAccessException)
        {
            _problem = "The country file in the data folder could not be read; a fresh one is downloaded.";
            LogUnreadable(logger, error);
        }
    }

    /// <summary>Downloads this month's file, or last month's, unless that one is in use already.</summary>
    public async Task<GeoDatabaseState> UpdateAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var now = time.GetUtcNow();
            string? problem = null;
            foreach (var month in new[] { now, now.AddMonths(-1) }.Select(at => at.ToString("yyyy-MM", System.Globalization.CultureInfo.InvariantCulture)))
            {
                if (Month is { } current && string.CompareOrdinal(current, month) >= 0 && geo.Ready)
                {
                    _problem = problem;
                    return State;
                }

                var outcome = await DownloadAsync(month, cancellationToken);
                if (outcome is null)
                {
                    Month = month;
                    _problem = null;
                    LogUpdated(logger, month);
                    return State;
                }

                problem ??= outcome;
            }

            _problem = problem ?? "DB-IP's country file could not be downloaded.";
            return State;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Null when the month's file is now in use; otherwise why not.</summary>
    private async Task<string?> DownloadAsync(string month, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(folder);
        var url = UrlStart + month + ".mmdb.gz";
        var unpacked = Path.Combine(folder, $"{FileName}.{Guid.NewGuid():N}.new");
        try
        {
            using var http = new HttpClient(handler, disposeHandler: false) { Timeout = TimeSpan.FromMinutes(5) };
            using var response = await http.GetAsync(new Uri(url), HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                return $"DB-IP has no country file for {month} yet.";
            }

            if (!response.IsSuccessStatusCode)
            {
                return $"DB-IP answered {(int)response.StatusCode} for the country file of {month}.";
            }

            if (response.Content.Headers.ContentLength > MaxDownloadBytes)
            {
                return "DB-IP's country file was far larger than it should be, so it was not used.";
            }

            await using (var body = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var gzip = new GZipStream(new LimitedStream(body, MaxDownloadBytes), CompressionMode.Decompress))
            await using (var output = new FileStream(unpacked, FileMode.CreateNew, FileAccess.Write))
            {
                await new LimitedStream(gzip, MaxFileBytes).CopyToAsync(output, cancellationToken);
            }

            var database = MmdbCountryDatabase.Open(unpacked);
            File.Move(unpacked, FilePath, overwrite: true);
            await File.WriteAllTextAsync(Path.Combine(folder, MonthFile), month, cancellationToken);
            geo.UseDatabase(database);
            return null;
        }
        catch (Exception error) when (error is HttpRequestException or IOException or InvalidDataException or InvalidDatabaseException
            or (TaskCanceledException and not OperationCanceledException { CancellationToken.IsCancellationRequested: true }))
        {
            LogFailed(logger, month, error);
            return $"DB-IP's country file for {month} could not be used: {error.Message}";
        }
        finally
        {
            if (File.Exists(unpacked))
            {
                File.Delete(unpacked);
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "DB-IP's country file for {Month} is in use.")]
    private static partial void LogUpdated(ILogger logger, string month);

    [LoggerMessage(Level = LogLevel.Warning, Message = "DB-IP's country file for {Month} could not be downloaded or used; the one in use stays.")]
    private static partial void LogFailed(ILogger logger, string month, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The country file in the data folder could not be read.")]
    private static partial void LogUnreadable(ILogger logger, Exception error);

    /// <summary>Reads through to the inner stream and fails once more than the limit has come.</summary>
    private sealed class LimitedStream(Stream inner, long limit) : Stream
    {
        private long _read;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => _read;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, count));

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            Count(await inner.ReadAsync(buffer, cancellationToken));

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        private int Count(int read)
        {
            _read += read;
            return _read > limit ? throw new InvalidDataException("The download was larger than a country file can be.") : read;
        }
    }
}
