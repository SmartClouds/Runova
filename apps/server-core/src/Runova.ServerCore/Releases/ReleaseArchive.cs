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
            // Every name a loader may apply: the classic store takes manifest.json's RepoTags, the
            // containerd store index.json's annotations. The whole archive is read, and a second
            // copy of either file (one tar extraction would let win) is refused outright.
            List<string>? names = null;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            await using var reader = new TarReader(content, leaveOpen: true);
            while (await reader.GetNextEntryAsync(copyData: false, cancellationToken) is { } entry)
            {
                var name = entry.Name.TrimStart('.', '/');
                if (name is not ("manifest.json" or "index.json") || entry.DataStream is null)
                {
                    continue;
                }

                if (!seen.Add(name))
                {
                    throw new InvalidDataException($"The archive holds more than one {name}, which docker save never writes.");
                }

                if (entry.Length > MaxManifestBytes)
                {
                    throw new InvalidDataException($"The archive's {name} is too large to be a docker save manifest.");
                }

                using var document = await JsonDocument.ParseAsync(entry.DataStream, cancellationToken: cancellationToken);
                if (name == "manifest.json")
                {
                    if (document.RootElement.ValueKind != JsonValueKind.Array)
                    {
                        throw new InvalidDataException("The archive's manifest.json is not a docker save manifest.");
                    }

                    (names ??= []).AddRange(document.RootElement.EnumerateArray()
                        .Where(image => image.ValueKind == JsonValueKind.Object && image.TryGetProperty("RepoTags", out var tags) && tags.ValueKind == JsonValueKind.Array)
                        .SelectMany(image => image.GetProperty("RepoTags").EnumerateArray())
                        .Where(tag => tag.ValueKind == JsonValueKind.String)
                        .Select(tag => tag.GetString()!));
                }
                else
                {
                    IndexNames(document.RootElement, seen.Contains("manifest.json") ? names! : (names ??= []));
                }
            }

            if (names is not null && seen.Contains("manifest.json"))
            {
                return [.. names.Distinct(StringComparer.Ordinal)];
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

    /// <summary>The image names in an OCI index.json, as the containerd image store reads them.</summary>
    private static void IndexNames(JsonElement index, List<string> names)
    {
        if (index.ValueKind != JsonValueKind.Object || !index.TryGetProperty("manifests", out var manifests) || manifests.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("The archive's index.json is not an OCI image index.");
        }

        foreach (var manifest in manifests.EnumerateArray())
        {
            if (manifest.ValueKind != JsonValueKind.Object || !manifest.TryGetProperty("annotations", out var annotations) || annotations.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            foreach (var key in new[] { "io.containerd.image.name", "org.opencontainers.image.ref.name" })
            {
                // A bare tag ("latest") names nothing by itself; a full reference does.
                if (annotations.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
                    && value.GetString() is { } reference && (reference.Contains('/', StringComparison.Ordinal) || reference.Contains(':', StringComparison.Ordinal)))
                {
                    names.Add(reference);
                }
            }
        }
    }
}
