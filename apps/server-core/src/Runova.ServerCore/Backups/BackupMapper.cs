using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using Docker.DotNet.Models;
using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Backups;

[Mapper]
internal static partial class BackupMapper
{
    [MapProperty(nameof(BackupRunRecord.StartedAt), nameof(BackupRunInfo.StartedAtUnixMs))]
    [MapProperty(nameof(BackupRunRecord.FinishedAt), nameof(BackupRunInfo.FinishedAtUnixMs))]
    public static partial BackupRunInfo ToInfo(BackupRunRecord run, IEnumerable<BackupRunTargetRecord> targets);

    /// <summary>The destinations, the next run and the last one come from other tables and the schedule.</summary>
    public static partial BackupPlanInfo ToInfo(BackupPlanRecord plan, Guid[] destinationIds, long? nextRunAtUnixMs, BackupRunInfo? lastRun);

    /// <summary>The caller reads the stored settings and sums them up; the sealed secret itself never leaves.</summary>
    [MapperIgnoreSource(nameof(BackupDestinationRecord.Settings))]
    [MapPropertyFromSource(nameof(BackupDestinationInfo.HasSecret), Use = nameof(HasSecret))]
    [MapProperty(nameof(BackupDestinationRecord.LastTestedAt), nameof(BackupDestinationInfo.LastTestedAtUnixMs))]
    public static partial BackupDestinationInfo ToInfo(BackupDestinationRecord row, BackupDestinationSettings settings, string summary);

    [MapProperty(nameof(BackupKeyRingRecord.Slot), nameof(BackupKeyRing.Slot), Use = nameof(ReadSlot))]
    [MapProperty(nameof(BackupKeyRingRecord.CreatedAt), nameof(BackupKeyRing.CreatedAtUnixMs))]
    public static partial BackupKeyRing ToKeyRing(BackupKeyRingRecord row);

    /// <summary>A new key ring as stored: the sealed slot as JSON. It is the only row there is.</summary>
    [MapperIgnoreTarget(nameof(BackupKeyRingRecord.Id))]
    [MapProperty(nameof(BackupKeyRing.Slot), nameof(BackupKeyRingRecord.Slot), Use = nameof(WriteSlot))]
    public static partial BackupKeyRingRecord ToRecord(BackupKeyRing ring, long createdAt, long updatedAt);

    [MapProperty(nameof(BackupManifestFile.Parts), nameof(StoredBackupInfo.Parts), Use = nameof(PartCount))]
    public static partial StoredBackupInfo ToStoredInfo(BackupManifestFile manifest, Guid destinationId);

    public static partial StoredBackup ToStored(BackupManifestFile manifest);

    /// <summary>A volume as the archive lists it, once its file is written.</summary>
    public static partial VolumeEntry ToEntry(BackupVolume volume, string file, long sizeBytes);

    /// <summary>An image as the archive lists it; no file when it was not saved.</summary>
    public static partial ImageEntry ToEntry(BackupImage image, string? file);

    public static partial BackupVolume ToVolume(VolumeEntry entry);

    /// <summary>A volume as Docker lists it, its labels copied so the backup keeps its own.</summary>
    [MapProperty(nameof(VolumeResponse.Driver), nameof(BackupVolume.Driver), Use = nameof(DriverOrLocal))]
    [MapProperty(nameof(VolumeResponse.Labels), nameof(BackupVolume.Labels), Use = nameof(LabelsOf))]
    public static partial BackupVolume ToVolume(VolumeResponse volume);

    /// <summary>An image as Docker lists it, without the placeholder tag of an untagged one.</summary>
    [MapProperty(nameof(ImagesListResponse.ID), nameof(BackupImage.Id))]
    [MapProperty(nameof(ImagesListResponse.RepoTags), nameof(BackupImage.Tags), Use = nameof(RealTags))]
    [MapProperty(nameof(ImagesListResponse.RepoDigests), nameof(BackupImage.RepoDigests), Use = nameof(DigestsOf))]
    public static partial BackupImage ToImage(ImagesListResponse image);

    /// <summary>Each site's domains, read in the query itself.</summary>
    public static partial IQueryable<SiteHostname> ToHostnames(IQueryable<SiteDomain> domains);

    /// <summary>A run's targets, by destination name.</summary>
    [UserMapping(Default = true)]
    private static BackupRunTargetInfo[] ToTargets(IEnumerable<BackupRunTargetRecord> targets) =>
        [.. targets.OrderBy(t => t.DestinationName).Select(ToTarget)];

    private static partial BackupRunTargetInfo ToTarget(BackupRunTargetRecord target);

    private static partial SiteHostname ToHostname(SiteDomain domain);

    private static bool HasSecret(BackupDestinationRecord row) => row.ProtectedSecret is not null;

    private static BackupKeySlot ReadSlot(string slot) => JsonSerializer.Deserialize(slot, BackupStoreJson.Default.BackupKeySlot)!;

    private static string WriteSlot(BackupKeySlot slot) => JsonSerializer.Serialize(slot, BackupStoreJson.Default.BackupKeySlot);

    private static int PartCount(IReadOnlyList<BackupPartInfo> parts) => parts.Count;

    private static string DriverOrLocal(string? driver) => driver ?? "local";

    [SuppressMessage("Performance", "CA1859", Justification = "Mapperly needs the target member's own type.")]
    private static IReadOnlyDictionary<string, string> LabelsOf(IDictionary<string, string>? labels) =>
        (IReadOnlyDictionary<string, string>?)labels?.ToDictionary(StringComparer.Ordinal) ?? new Dictionary<string, string>();

    private static string[] RealTags(IList<string>? tags) => [.. (tags ?? []).Where(tag => tag != "<none>:<none>")];

    private static string[] DigestsOf(IList<string>? digests) => [.. digests ?? []];
}
