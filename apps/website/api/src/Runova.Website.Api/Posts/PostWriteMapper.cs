using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Posts;

namespace Runova.Website.Api.Posts;

/// <summary>A post as it would be written, for the audit entry's before and after.</summary>
[Mapper]
internal static partial class PostWriteMapper
{
    [MapProperty(nameof(Post.Tags), nameof(PostWriteDto.Tags), Use = nameof(TagNames))]
    public static partial PostWriteDto ToWriteDto(Post post);

    // By slug, so the same tags always read the same.
    [UserMapping(Default = false)]
    private static List<string> TagNames(List<Tag> tags) => [.. tags.OrderBy(t => t.Slug, StringComparer.Ordinal).Select(t => t.Name)];
}
