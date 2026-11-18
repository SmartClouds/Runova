using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Traffic;

/// <summary>Whether nginx now refuses the addresses, or why the old list stays.</summary>
internal sealed record BlockListOutcome(bool Applied, string? Error = null);

/// <summary>
/// The addresses nginx refuses on every site (E110), in <see cref="NginxLayout.BlockListFile"/>,
/// which a geo map at the http level reads. Blocking rewrites only that file, under the applier's
/// lock, checks it with nginx -t and reloads, and puts the old file back when nginx refuses either.
/// It never renders or applies the sites: saved site changes wait for their own apply.
/// </summary>
internal sealed partial class BlockList(NginxControl control, NginxApplier applier, OsInfo os, ILogger<BlockList> logger)
{
    public const string Header = "# Managed by Runova. Addresses blocked under Traffic, one per line; nginx answers them with nothing.";

    private const UnixFileMode Readable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    /// <summary>One line per network, each once, in order, so the same list always gives the same file.</summary>
    public static string Render(IEnumerable<string> networks)
    {
        ArgumentNullException.ThrowIfNull(networks);
        var text = new StringBuilder(Header).Append('\n');
        foreach (var network in networks.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            text.Append(network).Append(" 1;\n");
        }

        return text.ToString();
    }

    /// <summary>
    /// Makes nginx refuse exactly these networks, which must be canonical (as
    /// <see cref="NginxAddresses.TryParseNetwork"/> gives them). Before nginx is set up the file is
    /// only written, ready for the first release.
    /// </summary>
    public async Task<BlockListOutcome> ApplyAsync(IReadOnlyCollection<string> networks, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(networks);
        foreach (var network in networks)
        {
            if (!NginxAddresses.TryParseNetwork(network, out var canonical, out var problem) || canonical != network)
            {
                return new BlockListOutcome(false, problem ?? $"'{network}' is not written the way nginx is given networks.");
            }
        }

        using var lease = await applier.LockAsync(cancellationToken);
        var inspection = await control.InspectAsync(NginxControl.LayoutFor(os.Family, NginxInspection.Missing(false, true)), cancellationToken);
        var layout = NginxControl.LayoutFor(os.Family, inspection);
        var machine = control.Machine;
        var path = layout.BlockListFile;
        var old = await machine.ReadTextAsync(path, cancellationToken);
        var text = Render(networks);
        if (old == text)
        {
            return new BlockListOutcome(true);
        }

        await machine.WriteAsync(path, Encoding.UTF8.GetBytes(text), Readable, cancellationToken);
        if (!inspection.Managed)
        {
            return new BlockListOutcome(true);
        }

        var test = await control.TestAsync(cancellationToken);
        if (!test.Succeeded)
        {
            await RestoreAsync(path, old);
            LogRefused(logger);
            return new BlockListOutcome(false, (test.StandardError + test.StandardOutput).Trim());
        }

        if (!inspection.Running)
        {
            return new BlockListOutcome(true);
        }

        var reload = await control.ReloadAsync(inspection, layout, cancellationToken);
        if (!reload.Confirmed)
        {
            // nginx kept the old list in memory; the file goes back so a later reload keeps it too.
            await RestoreAsync(path, old);
            LogRefused(logger);
            return new BlockListOutcome(false, reload.Error.Trim());
        }

        return new BlockListOutcome(true);
    }

    /// <summary>The old file, or an empty list when there was none: nginx must always find one.</summary>
    private async Task RestoreAsync(string path, string? old)
    {
        // Putting it back must finish even when the caller has gone.
        using var budget = new CancellationTokenSource(TimeSpan.FromMinutes(1));
        await control.Machine.WriteAsync(path, Encoding.UTF8.GetBytes(old ?? Render([])), Readable, budget.Token);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "nginx refused the new list of blocked addresses; the old one stays.")]
    private static partial void LogRefused(ILogger logger);
}
