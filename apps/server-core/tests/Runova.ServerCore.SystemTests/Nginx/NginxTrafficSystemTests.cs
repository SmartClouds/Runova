using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Tests.Nginx;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.SystemTests.Nginx;

public sealed class DebianNginxTrafficTests(DebianNginxFixture fixture) : NginxTrafficSystemTests(fixture), IClassFixture<DebianNginxFixture>;

public sealed class RockyNginxTrafficTests(RockyNginxFixture fixture) : NginxTrafficSystemTests(fixture), IClassFixture<RockyNginxFixture>;

/// <summary>
/// E109 T1 and E110 T3 against real nginx.org nginx: it takes the runova_main log format and writes
/// lines the parser reads with every field, and an address in blocked.conf gets no answer at all
/// on the site until it is unblocked, without a new release.
/// </summary>
public abstract class NginxTrafficSystemTests(NginxHarnessFixture fixture)
{
    private const string Domain = "traffic.test";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static string[] Http(string path = "/") => ["--resolve", $"{Domain}:80:127.0.0.1", $"http://{Domain}{path}"];

    private async Task<NginxApplySystemTests.Core> StartAsync()
    {
        DockerCli.RequireAvailable();
        var core = NginxApplySystemTests.Connect(await fixture.GetAsync());
        var applied = await core.ApplyAsync(new NginxConfiguration([NginxApplySystemTests.Site("traffic-app", Domain) with { BasicAuth = null }], []));
        Assert.True(applied.Applied, string.Join("\n", applied.Problems) + applied.Error);
        return core;
    }

    [Fact]
    public async Task Nginx_writes_the_runova_main_format_and_the_parser_reads_every_field()
    {
        var core = await StartAsync();

        var response = await core.Harness.CurlAsync(Cancel, ["-A", "Mozilla/5.0 (X11; Linux x86_64) Firefox/133.0", "-H", "CF-IPCountry: DE", "-e", "https://news.example.org/top", .. Http("/traffic?x=1")]);

        Assert.Equal(200, response.Status);
        var log = await core.Machine.ReadTextAsync(core.Layout.AccessLog("traffic-app"), Cancel) ?? string.Empty;
        var last = log.TrimEnd('\n').Split('\n')[^1];
        Assert.True(AccessLogParser.TryParse(Encoding.UTF8.GetBytes(last), out var line), last);
        Assert.True(line.Extended, last);
        Assert.Equal("127.0.0.1", AccessLogParser.Text(line.RemoteAddress));
        Assert.Equal("GET", AccessLogParser.Text(line.Method));
        Assert.Equal("/traffic?x=1", AccessLogParser.Text(line.Target));
        Assert.Equal(200, line.Status);
        Assert.Equal("https://news.example.org/top", AccessLogParser.Text(line.Referrer));
        Assert.Equal(Domain, AccessLogParser.Text(line.Host));
        Assert.True(line.RequestTimeMs >= 0);
        Assert.Equal("http", AccessLogParser.Text(line.Scheme));
        Assert.Equal("127.0.0.1", AccessLogParser.Text(line.ConnectingAddress));
        Assert.Equal("DE", AccessLogParser.Text(line.CloudflareCountry));
    }

    [Fact]
    public async Task A_blocked_address_gets_no_answer_until_it_is_unblocked()
    {
        var core = await StartAsync();
        var release = await core.Machine.ReadLinkAsync(core.Layout.CurrentLink, Cancel);
        var blocks = new BlockList(core.Control, core.Applier, Os(core), NullLogger<BlockList>.Instance);

        try
        {
            // curl runs inside the container, so its requests come from 127.0.0.1.
            var blocked = await blocks.ApplyAsync(["127.0.0.1"], Cancel);
            Assert.True(blocked.Applied, blocked.Error);
            var refused = await core.Harness.CurlRawAsync(Cancel, ["-o", "/dev/null", "-w", "%{http_code}", .. Http()]);

            // nginx closes the connection without a word: curl reports an empty reply (52).
            Assert.Equal(52, refused.ExitCode);
            Assert.Equal(release, await core.Machine.ReadLinkAsync(core.Layout.CurrentLink, Cancel));
        }
        finally
        {
            var unblocked = await blocks.ApplyAsync([], Cancel);
            Assert.True(unblocked.Applied, unblocked.Error);
        }

        Assert.Equal(200, (await core.Harness.CurlAsync(Cancel, Http())).Status);
    }

    [Fact]
    public async Task Nginx_refuses_a_broken_blocked_file_and_blocking_writes_a_good_one()
    {
        var core = await StartAsync();
        var blocks = new BlockList(core.Control, core.Applier, Os(core), NullLogger<BlockList>.Instance);
        await core.Machine.WriteAsync(core.Layout.BlockListFile, "this is not a geo entry at all;\n"u8.ToArray(), UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead, Cancel);

        try
        {
            Assert.False((await core.Harness.TestConfigurationAsync(Cancel)).Succeeded);
        }
        finally
        {
            Assert.True((await blocks.ApplyAsync([], Cancel)).Applied);
        }

        Assert.True((await core.Harness.TestConfigurationAsync(Cancel)).Succeeded);
    }

    private static OsInfo Os(NginxApplySystemTests.Core core) =>
        core.Layout.TrustedCertificates == NginxLayout.RhelTrustedCertificates
            ? new OsInfo("rocky", "9", "Rocky Linux 9", OsFamily.Rhel, Supported: true)
            : new OsInfo("debian", "13", "Debian 13", OsFamily.Debian, Supported: true);
}
