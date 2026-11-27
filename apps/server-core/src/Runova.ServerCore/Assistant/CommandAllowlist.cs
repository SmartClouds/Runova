namespace Runova.ServerCore.Assistant;

/// <summary>
/// The read-only diagnostics a command may be to run without an approval: one simple command,
/// nothing a shell would read as more than words. The text may only hold letters, digits, spaces
/// and <c>._/:=,@+-</c>, so there are no variables, redirections, pipes or command separators to
/// hide anything behind. The one exception is a name pattern for find (<c>-name *.log</c>): its
/// value may hold <c>*</c> and <c>?</c>, and may be wrapped in one pair of quotes, which come off
/// before it runs. The program and its subcommand must be on the list below, and every flag must be
/// one that only reads (no following a log, no writing a file, no killing a socket, no find -exec
/// or -delete). A command that passes runs from its argument list, never through a shell, so a
/// pattern reaches find as it was written and nothing expands it.
/// </summary>
/// <remarks>
/// A blocklist of dangerous patterns is easy to get around (base64, eval, an alias); this list
/// only lets through what it names, and anything it does not know waits for the user.
/// </remarks>
internal static class CommandAllowlist
{
    public const int MaxLength = 512;

    private const int MaxTokens = 24;

    /// <param name="Path">The program and subcommand words, matched exactly.</param>
    /// <param name="Letters">Single-letter flags that may be grouped, as in <c>-tlnp</c>.</param>
    /// <param name="Flags">Whole flags without a value.</param>
    /// <param name="ValueFlags">Flags followed by a value, as <c>-n 50</c>, <c>-n50</c> or <c>--tail=50</c>.</param>
    /// <param name="MaxPositionals">How many plain words may follow (container names, units, paths).</param>
    /// <param name="Required">A flag the command must carry (docker stats only reads once with --no-stream).</param>
    /// <param name="Verbs">When set, what the first plain word must be (ip addr show, not ip addr flush).</param>
    /// <param name="Patterns">Value flags whose value is a pattern, which may hold <c>*</c> and <c>?</c> and come quoted.</param>
    private sealed record Rule(
        string[] Path,
        string Letters = "",
        string[]? Flags = null,
        string[]? ValueFlags = null,
        int MaxPositionals = 0,
        string? Required = null,
        string[]? Verbs = null,
        string[]? Patterns = null)
    {
        public string[] AllFlags { get; } = Flags ?? [];

        public string[] AllValueFlags { get; } = ValueFlags ?? [];

        public string[] AllPatterns { get; } = Patterns ?? [];
    }

    private static readonly string[] _findPatterns =
    [
        "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-lname", "-ilname", "-regex", "-iregex",
    ];

    /// <summary>
    /// What find may do: tests and the actions that only print. Nothing that runs a program (-exec,
    /// -execdir, -ok, -okdir), deletes (-delete) or writes a file (-fprint, -fprint0, -fprintf, -fls).
    /// </summary>
    private static readonly Rule _find = new(
        ["find"],
        Flags:
        [
            "-L", "-H", "-P", "-xdev", "-mount", "-depth", "-daystart", "-not", "-a", "-o", "-and", "-or",
            "-print", "-print0", "-ls", "-quit", "-empty", "-readable", "-writable", "-executable",
            "-nouser", "-nogroup", "-true", "-false",
        ],
        ValueFlags:
        [
            .. _findPatterns, "-maxdepth", "-mindepth", "-type", "-xtype", "-mtime", "-mmin", "-atime", "-amin",
            "-ctime", "-cmin", "-newer", "-size", "-user", "-group", "-uid", "-gid", "-perm", "-links", "-inum",
            "-samefile",
        ],
        MaxPositionals: 4,
        Patterns: _findPatterns);

    private static readonly string[] _dockerLogFlags = ["--timestamps", "--details", "-t"];

    private static readonly string[] _journalFlags =
    [
        "--no-pager", "--boot", "--dmesg", "--catalog", "--utc", "--no-hostname", "--reverse", "--quiet",
        "-b", "-k", "-x", "-r", "-q", "-e", "--pager-end",
    ];

    private static readonly string[] _journalValueFlags =
    [
        "-u", "--unit", "-n", "--lines", "--since", "--until", "-S", "-U", "-p", "--priority", "-o", "--output",
        "-t", "--identifier", "--grep", "-g",
    ];

    private static readonly string[] _show = ["show", "list", "ls"];

    private static readonly Rule[] _rules =
    [
        new(["docker", "ps"], Letters: "aqs", Flags: ["--all", "--no-trunc", "--size", "--quiet", "--latest", "-l"], ValueFlags: ["-n", "--last", "--filter", "-f"]),
        new(["docker", "container", "ls"], Letters: "aqs", Flags: ["--all", "--no-trunc", "--size", "--quiet"], ValueFlags: ["-n", "--last", "--filter", "-f"]),
        new(["docker", "logs"], Flags: _dockerLogFlags, ValueFlags: ["-n", "--tail", "--since", "--until"], MaxPositionals: 1),
        new(["docker", "inspect"], Flags: ["--size", "-s"], ValueFlags: ["--type"], MaxPositionals: 8),
        new(["docker", "stats"], Flags: ["--no-stream", "--no-trunc", "--all", "-a"], MaxPositionals: 8, Required: "--no-stream"),
        new(["docker", "top"], MaxPositionals: 1),
        new(["docker", "port"], MaxPositionals: 2),
        new(["docker", "images"], Letters: "aq", Flags: ["--all", "--digests", "--no-trunc", "--quiet"], ValueFlags: ["--filter", "-f"], MaxPositionals: 1),
        new(["docker", "image", "ls"], Letters: "aq", Flags: ["--all", "--digests", "--no-trunc", "--quiet"], ValueFlags: ["--filter", "-f"], MaxPositionals: 1),
        new(["docker", "version"]),
        new(["docker", "info"]),
        new(["docker", "system", "df"], Flags: ["-v", "--verbose"]),
        new(["docker", "network", "ls"], Flags: ["--no-trunc", "-q", "--quiet"]),
        new(["docker", "network", "inspect"], MaxPositionals: 8),
        new(["docker", "volume", "ls"], Flags: ["-q", "--quiet"]),
        new(["docker", "volume", "inspect"], MaxPositionals: 8),
        new(["docker", "compose", "ls"], Flags: ["--all", "-a"]),
        new(["docker", "compose", "ps"], Letters: "aq", Flags: ["--all", "--quiet", "--services"], ValueFlags: ["-p", "--project-name"], MaxPositionals: 8),
        new(["docker", "compose", "logs"], Flags: [.. _dockerLogFlags, "--no-color", "--no-log-prefix"], ValueFlags: ["-p", "--project-name", "-n", "--tail", "--since", "--until"], MaxPositionals: 8),
        new(["docker", "compose", "top"], ValueFlags: ["-p", "--project-name"], MaxPositionals: 8),
        new(["docker", "compose", "images"], ValueFlags: ["-p", "--project-name"], MaxPositionals: 8),
        new(["systemctl", "status"], Letters: "l", Flags: ["--no-pager", "--full", "--all"], ValueFlags: ["-n", "--lines"], MaxPositionals: 8),
        new(["systemctl", "is-active"], MaxPositionals: 8),
        new(["systemctl", "is-enabled"], MaxPositionals: 8),
        new(["systemctl", "is-failed"], MaxPositionals: 8),
        new(["systemctl", "list-units"], Flags: ["--no-pager", "--failed", "--all", "--plain", "--no-legend"], ValueFlags: ["--type", "-t", "--state"], MaxPositionals: 2),
        new(["systemctl", "list-timers"], Flags: ["--no-pager", "--all"]),
        new(["systemctl", "--failed"], Flags: ["--no-pager"]),
        new(["journalctl"], Flags: _journalFlags, ValueFlags: _journalValueFlags),
        new(["df"], Letters: "hHiTPlak", Flags: ["--total", "--human-readable", "--inodes", "--print-type"], MaxPositionals: 4),
        new(["free"], Letters: "hmgkbtwl", Flags: ["--human", "--si", "--total", "--wide"]),
        new(["ss"], Letters: "tulnpaxsw46eimoHO", Flags: ["--summary"]),
        new(["uptime"], Letters: "ps", Flags: ["--pretty", "--since"]),
        new(["uname"], Letters: "asnrvmpio"),
        new(["hostname"], Letters: "fIisd"),
        new(["whoami"]),
        new(["id"]),
        new(["date"], Letters: "uRI", Flags: ["--utc"]),
        new(["nproc"]),
        new(["lscpu"]),
        new(["lsblk"], Letters: "fampSb"),
        new(["ip", "addr"], Flags: ["-4", "-6", "-br", "-c"], MaxPositionals: 2, Verbs: _show),
        new(["ip", "a"], Flags: ["-4", "-6", "-br", "-c"], MaxPositionals: 2, Verbs: _show),
        new(["ip", "route"], Flags: ["-4", "-6", "-c"], MaxPositionals: 1, Verbs: _show),
        new(["ip", "r"], Flags: ["-4", "-6", "-c"], MaxPositionals: 1, Verbs: _show),
        new(["ip", "link"], Flags: ["-br", "-c"], MaxPositionals: 2, Verbs: _show),
        new(["ip", "-br", "addr"]),
        new(["ip", "-br", "a"]),
        new(["ps"], Letters: "auxefwlHT", Flags: ["aux", "-ef", "auxf"], ValueFlags: ["--sort", "-o"], MaxPositionals: 1),
        new(["top"], Letters: "bc", ValueFlags: ["-n"]),
        new(["vmstat"], Letters: "swatS", MaxPositionals: 2),
        new(["du"], Letters: "shxcak", Flags: ["--summarize", "--human-readable"], ValueFlags: ["-d", "--max-depth"], MaxPositionals: 4),
        _find,
        new(["ls"], Letters: "laAhtrSdi1Fn", Flags: ["--all", "--almost-all", "--human-readable", "--full-time"], MaxPositionals: 8),
        new(["stat"], Letters: "L", MaxPositionals: 8),
        new(["dmesg"], Letters: "Tkx", Flags: ["--ctime", "--kernel"], ValueFlags: ["-l", "--level"]),
        new(["ufw", "status"], MaxPositionals: 1, Verbs: ["verbose", "numbered"]),
        new(["getenforce"]),
        new(["sestatus"]),
        new(["timedatectl"]),
        new(["timedatectl", "status"]),
        new(["hostnamectl"]),
        new(["hostnamectl", "status"]),
        new(["w"]),
        new(["who"]),
    ];

    /// <summary>What the app shows: each entry as a person would type its start.</summary>
    public static string[] Summary { get; } =
        [.. _rules.Select(rule => string.Join(' ', rule.Path)).Distinct(StringComparer.Ordinal)];

    /// <summary>The command's words when it may run unattended, or null.</summary>
    public static string[]? Parse(string? command)
    {
        if (string.IsNullOrWhiteSpace(command) || command.Length > MaxLength || !command.All(IsAllowedCharacter))
        {
            return null;
        }

        var words = command.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > MaxTokens)
        {
            return null;
        }

        // The longest matching path wins, so "docker compose ps" is not read as "docker" + words.
        var rule = _rules
            .Where(candidate => candidate.Path.Length <= words.Length && candidate.Path.SequenceEqual(words.Take(candidate.Path.Length), StringComparer.Ordinal))
            .OrderByDescending(candidate => candidate.Path.Length)
            .FirstOrDefault();
        if (rule is null || !Accepts(rule, words.AsSpan(rule.Path.Length)))
        {
            return null;
        }

        // Quotes and globs only in a pattern: the value right after a pattern flag. Elsewhere they
        // could only be meant for a shell, which never sees the command.
        for (var i = 0; i < words.Length; i++)
        {
            if (!words[i].Any(IsPatternCharacter))
            {
                continue;
            }

            var pattern = i > rule.Path.Length && rule.AllPatterns.Contains(words[i - 1], StringComparer.Ordinal)
                ? Unquote(words[i])
                : null;
            if (pattern is null)
            {
                return null;
            }

            words[i] = pattern;
        }

        return words;
    }

    /// <summary>
    /// A pattern as find should get it: without the one pair of quotes around it, when it has them.
    /// Null for a quote anywhere else, or nothing between the quotes.
    /// </summary>
    private static string? Unquote(string word)
    {
        var quoted = word.Length >= 2 && word[0] is '\'' or '"' && word[^1] == word[0];
        var inner = quoted ? word[1..^1] : word;
        return inner.Length > 0 && !inner.Any(character => character is '\'' or '"') ? inner : null;
    }

    private static bool Accepts(Rule rule, ReadOnlySpan<string> rest)
    {
        var positionals = 0;
        var required = rule.Required is null;
        for (var i = 0; i < rest.Length; i++)
        {
            var word = rest[i];
            if (word == "--")
            {
                return false;
            }

            if (word == rule.Required)
            {
                required = true;
            }

            if (rule.AllFlags.Contains(word, StringComparer.Ordinal))
            {
                continue;
            }

            if (word.StartsWith("--", StringComparison.Ordinal))
            {
                var equals = word.IndexOf('=', StringComparison.Ordinal);
                var name = equals < 0 ? word : word[..equals];
                if (!rule.AllValueFlags.Contains(name, StringComparer.Ordinal))
                {
                    return false;
                }

                if (equals < 0 && !TakeValue(rest, ref i))
                {
                    return false;
                }

                continue;
            }

            if (word.Length > 1 && word[0] == '-')
            {
                if (rule.AllValueFlags.Contains(word, StringComparer.Ordinal))
                {
                    if (!TakeValue(rest, ref i))
                    {
                        return false;
                    }

                    continue;
                }

                // A short value flag with its value attached: -n50.
                if (word.Length > 2 && rule.AllValueFlags.Contains(word[..2], StringComparer.Ordinal))
                {
                    continue;
                }

                if (rule.Letters.Length > 0 && word.Skip(1).All(letter => rule.Letters.Contains(letter, StringComparison.Ordinal)))
                {
                    continue;
                }

                return false;
            }

            if (++positionals > rule.MaxPositionals
                || (positionals == 1 && rule.Verbs is not null && !rule.Verbs.Contains(word, StringComparer.Ordinal)))
            {
                return false;
            }
        }

        return required;
    }

    /// <summary>
    /// A value for the flag at <paramref name="index"/>: the next word, which is not a flag (a
    /// relative time such as -1h is a value).
    /// </summary>
    private static bool TakeValue(ReadOnlySpan<string> rest, ref int index)
    {
        if (index + 1 >= rest.Length
            || (rest[index + 1].StartsWith('-') && !(rest[index + 1].Length > 1 && char.IsAsciiDigit(rest[index + 1][1]))))
        {
            return false;
        }

        index++;
        return true;
    }

    private static bool IsAllowedCharacter(char character) =>
        char.IsAsciiLetterOrDigit(character) || character is ' ' or '.' or '_' or '/' or ':' or '=' or ',' or '@' or '+' or '-'
        || IsPatternCharacter(character);

    /// <summary>What only a pattern may hold.</summary>
    private static bool IsPatternCharacter(char character) => character is '*' or '?' or '\'' or '"';
}
