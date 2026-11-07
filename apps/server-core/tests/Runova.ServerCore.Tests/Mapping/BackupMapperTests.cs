using Docker.DotNet.Models;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests.Mapping;

public sealed class BackupMapperTests
{
    private static readonly Guid _runId = Guid.NewGuid();
    private static readonly Guid _planId = Guid.NewGuid();

    [Fact]
    public void A_run_lists_its_targets_by_destination_name()
    {
        var run = new BackupRunRecord
        {
            Id = _runId,
            PlanId = _planId,
            PlanName = "Nightly",
            Trigger = BackupTrigger.Schedule,
            State = BackupRunState.Succeeded,
            StartedAt = 1_000,
            FinishedAt = 2_000,
            SizeBytes = 4_096,
            Sha256 = "abc",
            Error = "one target failed",
            RequestedByName = "alice",
        };
        var nas = Guid.NewGuid();
        var drive = Guid.NewGuid();
        BackupRunTargetRecord[] targets =
        [
            new() { RunId = _runId, DestinationId = nas, DestinationName = "NAS", State = BackupTargetState.Failed, Attempts = 3, Pruned = 0, Error = "refused", FinishedAt = 5 },
            new() { RunId = _runId, DestinationId = drive, DestinationName = "Drive", State = BackupTargetState.Succeeded, Attempts = 1, Pruned = 2 },
        ];

        var info = BackupMapper.ToInfo(run, targets);

        Assert.Equal(_runId, info.Id);
        Assert.Equal(_planId, info.PlanId);
        Assert.Equal("Nightly", info.PlanName);
        Assert.Equal(BackupTrigger.Schedule, info.Trigger);
        Assert.Equal(BackupRunState.Succeeded, info.State);
        Assert.Equal(1_000, info.StartedAtUnixMs);
        Assert.Equal(2_000, info.FinishedAtUnixMs);
        Assert.Equal(4_096, info.SizeBytes);
        Assert.Equal("one target failed", info.Error);
        Assert.Equal("alice", info.RequestedByName);
        Assert.Equal(
            [
                new BackupRunTargetInfo(drive, "Drive", BackupTargetState.Succeeded, 1, 2, null),
                new BackupRunTargetInfo(nas, "NAS", BackupTargetState.Failed, 3, 0, "refused"),
            ],
            info.Targets);
    }

    [Fact]
    public void A_plan_takes_its_destinations_next_run_and_last_run_from_the_caller()
    {
        var plan = new BackupPlanRecord { Id = _planId, Name = "Nightly", Enabled = true, Cron = "0 3 * * *", TimeZone = "UTC", KeepLast = 7, KeepDays = 30, CreatedAt = 1, UpdatedAt = 2 };
        Guid[] destinations = [Guid.NewGuid()];
        var last = new BackupRunInfo(_runId, _planId, "Nightly", BackupTrigger.Manual, BackupRunState.Running, 10, null, null, null, null, []);

        var info = BackupMapper.ToInfo(plan, destinations, 99, last);

        Assert.Equal(new BackupPlanInfo(_planId, "Nightly", true, "0 3 * * *", "UTC", 7, 30, destinations, 99, last), info);
    }

    [Fact]
    public void A_destination_says_whether_it_has_a_secret_but_never_shows_it()
    {
        var id = Guid.NewGuid();
        var row = new BackupDestinationRecord
        {
            Id = id,
            Name = "Box",
            Kind = BackupDestinationKind.Sftp,
            Settings = "{}",
            ProtectedSecret = "sealed",
            MaxPartBytes = 1_024,
            LastTestedAt = 77,
            LastError = "timed out",
        };
        var settings = new BackupDestinationSettings(Path: "/backups", Host: "example.com", Port: 22);

        var info = BackupMapper.ToInfo(row, settings, "example.com:/backups");

        Assert.Equal(new BackupDestinationInfo(id, "Box", BackupDestinationKind.Sftp, "example.com:/backups", settings, true, 1_024, 77, "timed out"), info);
        Assert.False(BackupMapper.ToInfo(new BackupDestinationRecord { Name = "Here", Settings = "{}" }, new BackupDestinationSettings(), "here").HasSecret);
    }

    [Fact]
    public void A_key_ring_goes_to_its_row_and_back()
    {
        var slot = new BackupKeySlot("PBKDF2-HMAC-SHA256", 600_000, "c2FsdA==", "bm9uY2U=", "d3JhcHBlZA==");
        var ring = new BackupKeyRing("key-1", "cHVibGlj", slot, 5);

        var row = BackupMapper.ToRecord(ring, 10, 20);

        Assert.Equal(BackupKeyRingRecord.SingletonId, row.Id);
        Assert.Equal("key-1", row.KeyId);
        Assert.Equal("cHVibGlj", row.PublicKey);
        Assert.Equal(10, row.CreatedAt);
        Assert.Equal(20, row.UpdatedAt);
        Assert.Contains("600000", row.Slot, StringComparison.Ordinal);
        Assert.Equal(ring with { CreatedAtUnixMs = 10 }, BackupMapper.ToKeyRing(row));
    }

    [Fact]
    public void A_manifest_lists_as_a_stored_backup_with_its_part_count()
    {
        var backupId = Guid.NewGuid();
        var destinationId = Guid.NewGuid();
        var manifest = new BackupManifestFile(
            BackupManifestFile.SchemaVersion,
            backupId,
            _planId,
            "web-1",
            1_000,
            8_192,
            "sha",
            "3.3.0",
            "key-1",
            [new BackupPartInfo(0, "a.part", 4_096, "s1"), new BackupPartInfo(1, "b.part", 4_096, "s2")]);

        Assert.Equal(new StoredBackupInfo(backupId, destinationId, _planId, "web-1", 1_000, 8_192, 2, "3.3.0", "key-1"), BackupMapper.ToStoredInfo(manifest, destinationId));
        Assert.Equal(new StoredBackup(backupId, _planId, 1_000), BackupMapper.ToStored(manifest));
    }

    [Fact]
    public void Volumes_and_images_go_into_the_archive_and_back()
    {
        var labels = new Dictionary<string, string> { ["com.docker.compose.project"] = "shop" };
        var volume = new BackupVolume("data", "local", labels);

        var entry = BackupMapper.ToEntry(volume, "data.tar", 2_048);

        Assert.Equal(new VolumeEntry("data", "local", labels, "data.tar", 2_048), entry);
        Assert.Equal(volume, BackupMapper.ToVolume(entry));

        var image = new BackupImage("sha256:1", ["nginx:1"], ["nginx@sha256:2"]);
        Assert.Equal(new ImageEntry("sha256:1", image.Tags, image.RepoDigests, "img.tar"), BackupMapper.ToEntry(image, "img.tar"));
        Assert.Null(BackupMapper.ToEntry(image, null).File);
    }

    [Fact]
    public void Docker_volumes_keep_their_own_labels_and_default_to_the_local_driver()
    {
        var labels = new Dictionary<string, string> { ["a"] = "1" };

        var volume = BackupMapper.ToVolume(new VolumeResponse { Name = "data", Driver = null!, Labels = labels });

        Assert.Equal("data", volume.Name);
        Assert.Equal("local", volume.Driver);
        Assert.Equal(labels, volume.Labels);
        Assert.NotSame(labels, volume.Labels);
        Assert.Empty(BackupMapper.ToVolume(new VolumeResponse { Name = "bare", Driver = "nfs" }).Labels);
        Assert.Equal("nfs", BackupMapper.ToVolume(new VolumeResponse { Name = "bare", Driver = "nfs" }).Driver);
    }

    [Fact]
    public void Docker_images_lose_the_placeholder_tag_of_an_untagged_image()
    {
        var image = BackupMapper.ToImage(new ImagesListResponse { ID = "sha256:1", RepoTags = ["<none>:<none>", "app:2"], RepoDigests = ["app@sha256:3"] });

        Assert.Equal("sha256:1", image.Id);
        Assert.Equal(["app:2"], image.Tags);
        Assert.Equal(["app@sha256:3"], image.RepoDigests);
        Assert.Empty(BackupMapper.ToImage(new ImagesListResponse { ID = "sha256:4" }).RepoDigests);
    }

    [Fact]
    public async Task Site_hostnames_are_read_in_the_query()
    {
        await using var database = await TestDatabase.CreateAsync();
        await using var db = await database.Contexts.CreateDbContextAsync(TestContext.Current.CancellationToken);

        var sql = BackupMapper.ToHostnames(db.SiteDomains).ToQueryString();
        Assert.Contains("\"SiteId\"", sql, StringComparison.Ordinal);
        Assert.Contains("\"Domain\"", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Position\"", sql, StringComparison.Ordinal);

        SiteDomain[] domains = [new() { SiteId = "shop", Domain = "shop.example.com", Position = 0 }];
        Assert.Equal([new SiteHostname("shop", "shop.example.com")], BackupMapper.ToHostnames(domains.AsQueryable()));
    }
}
