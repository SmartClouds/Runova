using Runova.Website.Api.News;
using Runova.Website.Api.Posts;
using Runova.Website.Core.News;
using Runova.Website.Core.Posts;

namespace Runova.Website.Tests.Mapping;

public class WriteMapperTests
{
    private static readonly DateTimeOffset _at = new(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public void A_news_item_maps_to_the_fields_it_is_written_with()
    {
        var item = new NewsItem
        {
            Id = 1,
            Slug = "big-hole",
            Title = "A big hole",
            Summary = "Patch now.",
            BodyMarkdown = "## Patch",
            BodyHtml = "<h2>Patch</h2>",
            Category = NewsCategory.Security,
            Severity = NewsSeverity.High,
            Technologies = [new AffectedTechnology { Technology = "docker", VersionRange = "<27.0.0", FixedIn = "27.0.0" }],
            CveIds = ["CVE-2026-41234"],
            CvssScore = 8.1m,
            SourceLinks = [new SourceLink { Title = "Advisory", Url = "https://example.com/a" }],
            Tags = ["docker"],
            Status = NewsStatus.Published,
            PublishedAt = _at,
        };

        var dto = NewsWriteMapper.ToWriteDto(item);

        Assert.Equal(("big-hole", "A big hole", "Patch now.", "## Patch"), (dto.Slug, dto.Title, dto.Summary, dto.BodyMarkdown));
        Assert.Equal((NewsCategory.Security, NewsSeverity.High, 8.1m, NewsStatus.Published, _at), (dto.Category!.Value, dto.Severity!.Value, dto.CvssScore!.Value, dto.Status!.Value, dto.PublishedAt!.Value));
        var technology = Assert.Single(dto.Technologies!);
        Assert.Equal(("docker", "<27.0.0", "27.0.0"), (technology.Technology, technology.VersionRange, technology.FixedIn));
        var link = Assert.Single(dto.SourceLinks!);
        Assert.Equal(("Advisory", "https://example.com/a"), (link.Title, link.Url));
        Assert.Equal(["CVE-2026-41234"], dto.CveIds!);
        Assert.Equal(["docker"], dto.Tags!);
    }

    [Fact]
    public void A_post_maps_to_the_fields_it_is_written_with_and_its_tag_names_by_slug()
    {
        var post = new Post
        {
            Id = 7,
            Slug = "hello",
            Title = "Hello",
            Excerpt = "First.",
            BodyMarkdown = "## Hi",
            BodyHtml = "<h2>Hi</h2>",
            CoverMediaId = 5,
            Tags = [new Tag { Slug = "zebra", Name = "Zebra" }, new Tag { Slug = "apple", Name = "Apple" }],
            Status = NewsStatus.Scheduled,
            PublishedAt = _at,
        };

        var dto = PostWriteMapper.ToWriteDto(post);

        Assert.Equal(("hello", "Hello", "First.", "## Hi", 5L), (dto.Slug, dto.Title, dto.Excerpt, dto.BodyMarkdown, dto.CoverMediaId!.Value));
        Assert.Equal((NewsStatus.Scheduled, _at), (dto.Status!.Value, dto.PublishedAt!.Value));
        Assert.Equal(["Apple", "Zebra"], dto.Tags!);
    }
}
