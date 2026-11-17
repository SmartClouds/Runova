using System.Formats.Tar;
using System.IO.Compression;
using System.Text.Json;

namespace Runova.ServerCore.Releases;

/// <summary>
/// Reads the image names a `docker save` archive holds (E105) from its manifest.json, plain or
/// gzipped, without unpacking anything, so a release asset that is not the app's image is refused
/// before Docker sees it.
/// </summary>
internal static class ReleaseArchive
{
    private const int MaxManifestBytes = 1024 * 1024;

    /// <summary>The RepoTags of every image in the archive file. Throws InvalidDataException when it is not a docker save archive.</summary>
    public static async Task<string[]> ReadTagsAsync(string path, CancellationToken cancellationToken)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, useAsync: true);
        return await ReadTagsAsync(file, cancellationToken);
    }

    /// <summary>The same from a stream that can seek back to its start (the gzip check reads two bytes first).</summary>
    public static async Task<string[]> ReadTagsAsync(Stream file, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(file);
        var magic = new byte[2];
        var read = await file.ReadAtLeastAsync(magic, 2, throwOnEndOfStream: false, cancellationToken);
        file.Position = 0;
        Stream content = read == 2 && magic[0] == 0x1f && magic[1] == 0x8b ? new GZipStream(file, CompressionMode.Decompress, leaveOpen: true) : file;
        try
        {
            await using var reader = new TarReader(content, leaveOpen: true);
            while (await reader.GetNextEntryAsync(copyData: false, cancellationToken) is { } entry)
            {
                if (entry.Name.TrimStart('.', '/') != "manifest.json" || entry.DataStream is null)
                {
                    continue;
                }

                if (entry.Length > MaxManifestBytes)
                {
                    throw new InvalidDataException("The archive's manifest.json is too large to be a docker save manifest.");
                }

                using var manifest = await JsonDocument.ParseAsync(entry.DataStream, cancellationToken: cancellationToken);
                if (manifest.RootElement.ValueKind != JsonValueKind.Array)
                {
                    throw new InvalidDataException("The archive's manifest.json is not a docker save manifest.");
                }

                return [.. manifest.RootElement.EnumerateArray()
                    .Where(image => image.ValueKind == JsonValueKind.Object && image.TryGetProperty("RepoTags", out var tags) && tags.ValueKind == JsonValueKind.Array)
                    .SelectMany(image => image.GetProperty("RepoTags").EnumerateArray())
                    .Where(tag => tag.ValueKind == JsonValueKind.String)
                    .Select(tag => tag.GetString()!)
                    .Distinct(StringComparer.Ordinal)];
            }
        }
        catch (Exception error) when (error is JsonException or FormatException or EndOfStreamException)
        {
            throw new InvalidDataException("The asset is not a docker save archive.", error);
        }
        finally
        {
            if (!ReferenceEquals(content, file))
            {
                await content.DisposeAsync();
            }
        }

        throw new InvalidDataException("The asset has no manifest.json, so it is not a docker save archive.");
    }
}
