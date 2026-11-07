using Runova.ServerCore.Assistant;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.CoreDomain;
using Runova.ServerCore.Data;
using Runova.ServerCore.DirectTls;
using Runova.ServerCore.Hardening;
using Runova.ServerCore.Metrics;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Mapping;

/// <summary>The mappers with a method or two each.</summary>
public sealed class SmallMapperTests
{
    [Fact]
    public void A_telegram_document_is_a_cloud_file_named_by_its_message()
    {
        Assert.Equal(new CloudFile("12345", "runova-1.part", 2_048), DestinationMapper.ToCloudFile(new TelegramDocument(12345, "runova-1.part", 2_048)));
    }

    [Fact]
    public void A_dns_token_shows_everything_but_the_token()
    {
        var row = new DnsCredential
        {
            Zone = "example.com",
            ZoneId = "z1",
            Provider = "cloudflare",
            ProtectedToken = "sealed",
            TokenId = "t1",
            CreatedAt = 1,
            UpdatedAt = 2,
            CreatedBy = "alice",
            LastUsedAt = 3,
            LastError = "forbidden",
        };

        Assert.Equal(new DnsCredentialInfo("example.com", "z1", "cloudflare", 1, 2, "t1", "alice", 3, "forbidden"), DnsCredentialMapper.ToInfo(row));
        Assert.Equal(new DnsZoneToken("example.com", "z1", "plain"), DnsCredentialMapper.ToZoneToken(row, "plain"));
    }

    [Fact]
    public void Metric_samples_go_to_their_rows_and_back_unchanged()
    {
        var sample = new MetricsSample(1_000, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7, 8, 9, 10, 11.5, 12.5, 13.5, 14.5, 15, 16);

        var row = MetricsMapper.ToRow(sample, 60);

        Assert.Equal(60, row.Resolution);
        Assert.Equal(1_000, row.At);
        Assert.Equal(1.5, row.CpuPercent);
        Assert.Equal(2.5, row.CpuIowaitPercent);
        Assert.Equal(3.5, row.CpuStealPercent);
        Assert.Equal(4.5, row.Load1);
        Assert.Equal(5.5, row.Load5);
        Assert.Equal(6.5, row.Load15);
        Assert.Equal(7, row.MemoryTotalBytes);
        Assert.Equal(8, row.MemoryUsedBytes);
        Assert.Equal(9, row.SwapTotalBytes);
        Assert.Equal(10, row.SwapUsedBytes);
        Assert.Equal(11.5, row.NetworkReceiveBytesPerSecond);
        Assert.Equal(12.5, row.NetworkTransmitBytesPerSecond);
        Assert.Equal(13.5, row.DiskReadBytesPerSecond);
        Assert.Equal(14.5, row.DiskWriteBytesPerSecond);
        Assert.Equal(15, row.DiskTotalBytes);
        Assert.Equal(16, row.DiskUsedBytes);
        Assert.Equal(sample, MetricsMapper.ToSample(row));
    }

    [Fact]
    public void Registry_sign_ins_keep_their_secret_to_the_core()
    {
        var id = Guid.NewGuid();
        var login = new RegistryLogin("ghcr.io", "bob", "s3cret", RegistryLoginSource.Request);

        var row = RegistryCredentialMapper.ToRecord(login, id, "sealed", 1, 2, "alice");

        Assert.Equal(id, row.Id);
        Assert.Equal("ghcr.io", row.Registry);
        Assert.Equal("bob", row.Username);
        Assert.Equal("sealed", row.SealedSecret);
        Assert.Equal(1, row.CreatedAt);
        Assert.Equal(2, row.UpdatedAt);
        Assert.Equal("alice", row.CreatedBy);
        Assert.Null(row.LastUsedAt);

        row.LastUsedAt = 3;
        Assert.Equal(new RegistryCredentialInfo(id, "ghcr.io", "bob", 1, 2, "alice", 3), RegistryCredentialMapper.ToInfo(row));
        Assert.Equal(new RegistryLogin("ghcr.io", "bob", "unsealed", RegistryLoginSource.Stored), RegistryCredentialMapper.ToLogin(row, "unsealed"));
    }

    [Fact]
    public void An_ssh_change_shows_its_snapshot_and_how_it_ended()
    {
        var id = Guid.NewGuid();
        var snapshot = new SshChangeSnapshot(id, "Turn off password sign-in", "old drop-in", "ssh.service", "alice", "10.0.0.1 51000", 1_000, 2_000);

        Assert.Equal(
            new SshHardeningChangeInfo(id, SshHardeningState.Failed, "Turn off password sign-in", 1_000, 2_000, "alice", 3_000, "sshd refused it"),
            SshChangeMapper.ToInfo(snapshot, SshHardeningState.Failed, 3_000, "sshd refused it"));
        Assert.Equal(
            new SshHardeningChangeInfo(id, SshHardeningState.AwaitingConfirmation, "Turn off password sign-in", 1_000, 2_000, "alice"),
            SshChangeMapper.ToInfo(snapshot, SshHardeningState.AwaitingConfirmation, null, null));
    }

    [Fact]
    public void An_approval_nonce_and_a_journal_request_reach_their_own_types()
    {
        var id = Guid.NewGuid();
        Assert.Equal(new ExecApprovalNonce(id, "nonce", 5_000), AssistantMapper.ToNonce(new IssuedExecNonce(id, "nonce", Guid.NewGuid(), Guid.NewGuid(), 5_000)));

        Assert.Equal(new JournalQuery("nginx.service", 50, 1_000, false), AssistantMapper.ToQuery(new JournalRequest("nginx.service", 50, 1_000, false)));
        Assert.Equal(new JournalQuery("nginx.service", JournalUnits.DefaultLines, null, true), AssistantMapper.ToQuery(new JournalRequest("nginx.service")));
    }

    [Fact]
    public void A_challenge_and_the_signed_in_user_leave_the_core_without_what_binds_them()
    {
        var id = Guid.NewGuid();
        Assert.Equal(
            new ChallengeResponse(id, "nonce", 9_000),
            AuthMapper.ToResponse(new IssuedChallenge(id, "nonce", Guid.NewGuid(), AuthPurpose.Login, null, 9_000)));

        var user = new CoreUser { Id = Guid.NewGuid(), UserName = "alice", TwoFactorEnabled = false, PasswordHash = "hash", SecurityStamp = "stamp" };
        string[] roles = ["Admin"];
        Assert.Equal(new SignedInUser(user.Id, "alice", roles, true), AuthMapper.ToSignedInUser(user, roles, true));
        user.UserName = null;
        Assert.Equal(string.Empty, AuthMapper.ToSignedInUser(user, roles, false).UserName);
    }

    [Fact]
    public void Audit_events_read_with_names_and_entries_become_the_next_link()
    {
        var actor = Guid.NewGuid();
        var device = Guid.NewGuid();
        var stored = new AuditEvent
        {
            Id = 9,
            At = 1_000,
            ActorUserId = actor,
            DeviceId = device,
            PeerUid = 0,
            Action = "user.create",
            Target = "bob",
            Parameters = "{\"role\":\"Viewer\"}",
            Result = AuditResult.Success,
            PrevHash = "prev",
            Hash = "hash",
        };

        Assert.Equal(
            new AuditEventInfo(9, 1_000, actor, device, 0, "user.create", "bob", "{\"role\":\"Viewer\"}", AuditResult.Success, "alice", "laptop"),
            AuditMapper.ToInfo(stored, "alice", "laptop"));
        Assert.Equal(new AuditVerificationInfo(false, 12, 7), AuditMapper.ToInfo(new AuditVerification(false, 12, 7)));

        var entry = new AuditEntry("user.create", AuditResult.Denied, actor, device, 1000, "bob", new Dictionary<string, string?> { ["role"] = "Owner" });
        var next = AuditMapper.ToEvent(entry, 10, 2_000, "{\"role\":\"Owner\"}", "hash");

        Assert.Equal(10, next.Id);
        Assert.Equal(2_000, next.At);
        Assert.Equal(actor, next.ActorUserId);
        Assert.Equal(device, next.DeviceId);
        Assert.Equal(1000, next.PeerUid);
        Assert.Equal("user.create", next.Action);
        Assert.Equal("bob", next.Target);
        Assert.Equal("{\"role\":\"Owner\"}", next.Parameters);
        Assert.Equal(AuditResult.Denied, next.Result);
        Assert.Equal("hash", next.PrevHash);
        Assert.Equal(string.Empty, next.Hash);
    }

    [Fact]
    public void Core_domain_settings_go_to_their_file_and_back()
    {
        var settings = new CoreDomainSettings(true, "core.example.com", 7444, CoreDomainSettings.NewKey(), ["10.0.0.0/8"], 5, "alice", CoreDomainMode.Cloudflare);

        var stored = CoreDomainMapper.ToStored(settings);

        Assert.Equal(new CoreDomainSettings.Stored(true, "core.example.com", 7444, settings.Key, settings.Sources, 5, "alice", CoreDomainMode.Cloudflare), stored);
        string[] checkedSources = ["10.0.0.0/8"];
        Assert.Equal(settings with { Enabled = false, Sources = checkedSources }, CoreDomainMapper.ToSettings(stored, false, checkedSources));
        Assert.Equal(CoreDomainMode.Direct, CoreDomainMapper.ToSettings(stored with { Mode = null }, true, []).Mode);
    }

    [Fact]
    public void Direct_tls_settings_go_to_their_file_and_back()
    {
        var settings = new DirectTlsSettings(true, 7443, ["192.0.2.0/24"], 5, "alice");

        var stored = DirectTlsMapper.ToStored(settings);

        Assert.Equal(new DirectTlsSettings.Stored(true, 7443, settings.Sources, 5, "alice"), stored);
        string[] checkedSources = ["192.0.2.0/24"];
        Assert.Equal(settings with { Sources = checkedSources }, DirectTlsMapper.ToSettings(stored with { Sources = null }, checkedSources));
    }
}
