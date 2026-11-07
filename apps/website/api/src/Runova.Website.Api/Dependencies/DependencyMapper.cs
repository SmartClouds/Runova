using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Dependencies;
using Runova.Website.Data.Dependencies;

namespace Runova.Website.Api.Dependencies;

[Mapper]
internal static partial class DependencyMapper
{
    public static partial DependencyAlertSettingsDto ToDto(DependencyAlertSettings settings);

    public static partial AlertPreferences ToPreferences(DependencyAlertSettings settings);

    public static partial FindingDto ToDto(DependencyFinding finding);

    public static partial Finding ToFinding(DependencyFinding finding);

    /// <summary>What was found, already narrowed to what the account wants to hear about, is the caller's to work out.</summary>
    [MapProperty(nameof(PackageInventory.Id), nameof(ProjectFindingsDto.InventoryId))]
    public static partial ProjectFindingsDto ToDto(
        PackageInventory inventory, bool muted, int total, string? worstSeverity, FindingCountsDto counts, IReadOnlyList<FindingDto> findings);

    /// <summary>The package count comes from the inventory's packages, so the caller passes it.</summary>
    public static partial PackageInventoryDto ToDto(PackageInventory inventory, int packageCount);

    /// <summary>For a request that passed validation: every field is there.</summary>
    [MapperIgnoreTarget(nameof(InventoryPackage.Id))]
    [MapperIgnoreTarget(nameof(InventoryPackage.InventoryId))]
    [MapProperty(nameof(InventoryPackageRequest.Name), nameof(InventoryPackage.Name), Use = nameof(Trimmed))]
    [MapProperty(nameof(InventoryPackageRequest.Version), nameof(InventoryPackage.Version), Use = nameof(Trimmed))]
    public static partial InventoryPackage ToPackage(InventoryPackageRequest package);

    public static partial InventoryItem ToItem(InventoryPackage package);

    public static partial PackageFactsView ToView(PackageFacts facts);

    public static partial AdvisoryView ToView(DependencyCheckJob.StoredAdvisory advisory);

    /// <summary>The first fixed version depends on the inventory's version, so the caller works it out.</summary>
    public static partial DependencyCheckJob.StoredAdvisory ToStored(OsvClient.Advisory advisory, string? fixedVersion);

    [UserMapping(Default = false)]
    private static string Trimmed(string? value) => value!.Trim();
}
