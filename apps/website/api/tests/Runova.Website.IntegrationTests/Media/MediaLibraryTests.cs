using System.Globalization;
using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.Identity;
using Runova.Website.Core.News;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;
using ApiScopes = Runova.Website.Core.ApiClients.ApiScopes;

namespace Runova.Website.IntegrationTests.Media;

/// <summary>Listing and deleting uploaded images. Each test has a database and a media folder of its own.</summary>
public sealed class MediaLibraryTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Media = "/api/v1/media";

    private readonly FakeTimeProvider _time = new(TestApiClients.Now);
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "runova-media-tests", Guid.NewGuid().ToString("N"));
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() =>
        _factory = new(await postgres.CreateDatabaseAsync(), time: _time, settings: new Dictionary<string, string> { ["Website:MediaPath"] = _folder });

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, recursive: true);
        }

        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task The_list_is_paged_newest_first_with_links_and_no_caching()
    {
        var editor = await EditorAsync();
        var ids = new List<long>();
        for (var i = 0; i < 3; i++)
        {
            ids.Add((await UploadAsync(editor, $"Image {i}")).GetProperty("id").GetInt64());
            _time.Advance(TimeSpan.FromMinutes(1));
        }

        var response = await editor.GetAsync($"{Media}?pageSize=2");
        var page = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        Assert.Equal([ids[2], ids[1]], page.GetProperty("items").EnumerateArray().Select(m => m.GetProperty("id").GetInt64()));
        Assert.Equal(["id", "url", "contentType", "width", "height", "size", "alt", "createdAt"], page.GetProperty("items")[0].EnumerateObject().Select(p => p.Name));
        Assert.Equal("Image 2", page.GetProperty("items")[0].GetProperty("alt").GetString());
        Assert.Equal(1, page.GetProperty("page").GetInt32());
        Assert.Equal(2, page.GetProperty("pageSize").GetInt32());
        Assert.Equal(3, page.GetProperty("totalItems").GetInt32());
        Assert.Equal(2, page.GetProperty("totalPages").GetInt32());
        Assert.Contains("rel=\"next\"", response.Headers.GetValues("Link").Single(), StringComparison.Ordinal);
        Assert.Equal("private, no-store", response.Headers.NonValidated["Cache-Control"].ToString());

        var last = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{Media}?pageSize=2&page=2"), HttpStatusCode.OK);
        Assert.Equal([ids[0]], last.GetProperty("items").EnumerateArray().Select(m => m.GetProperty("id").GetInt64()));
        var past = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{Media}?page=9"), HttpStatusCode.OK);
        Assert.Empty(past.GetProperty("items").EnumerateArray());
    }

    [Theory]
    [InlineData("pageSize=101", "pageSize")]
    [InlineData("pageSize=0", "pageSize")]
    [InlineData("page=0", "page")]
    public async Task A_page_out_of_range_gets_400(string query, string field)
    {
        var editor = await EditorAsync();

        var response = await editor.GetAsync($"{Media}?{query}");

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Media);
        Assert.Equal([field], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task Only_staff_and_posts_write_clients_may_list()
    {
        var (newsKey, newsSecret) = await TestApiClients.AddAsync(_factory.Services, scopes: [ApiScopes.NewsWrite]);
        var (postsKey, postsSecret) = await TestApiClients.AddAsync(_factory.Services, scopes: [ApiScopes.PostsWrite]);

        var anonymous = await _factory.CreateApiClient().GetAsync(Media);
        var newsClient = await TestApiClients.Http(_factory, newsKey, newsSecret).GetAsync(Media, TestContext.Current.CancellationToken);
        var postsClient = await TestApiClients.Http(_factory, postsKey, postsSecret).GetAsync(Media, TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(anonymous, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Media);
        await ProblemAssert.IsProblemAsync(newsClient, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Media);
        Assert.Equal(HttpStatusCode.OK, postsClient.StatusCode);
    }

    [Fact]
    public async Task Delete_removes_the_image_and_its_file_and_writes_an_audit_entry()
    {
        var editor = await EditorAsync();
        var media = await UploadAsync(editor, "Going away");
        var id = media.GetProperty("id").GetInt64();
        var file = StoredFile(media);
        Assert.True(File.Exists(file));

        var response = await editor.SendAsync(HttpMethod.Delete, $"{Media}/{id}");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.False(File.Exists(file));
        Assert.Empty((await ApiClient.ReadJsonAsync(await editor.GetAsync(Media), HttpStatusCode.OK)).GetProperty("items").EnumerateArray());
        using var scope = _factory.Services.CreateScope();
        var entry = await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries.AsNoTracking()
            .Where(e => e.TargetType == "media" && e.TargetId == id.ToString(CultureInfo.InvariantCulture))
            .OrderBy(e => e.Id)
            .LastAsync(TestContext.Current.CancellationToken);
        Assert.Equal("media.delete", entry.Action);
    }

    [Fact]
    public async Task Deleting_an_unknown_or_deleted_image_gets_404()
    {
        var editor = await EditorAsync();
        var id = (await UploadAsync(editor, "Twice")).GetProperty("id").GetInt64();
        Assert.Equal(HttpStatusCode.NoContent, (await editor.SendAsync(HttpMethod.Delete, $"{Media}/{id}")).StatusCode);

        var again = await editor.SendAsync(HttpMethod.Delete, $"{Media}/{id}");
        var unknown = await editor.SendAsync(HttpMethod.Delete, $"{Media}/999999");

        await ProblemAssert.IsProblemAsync(again, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), $"{Media}/{id}");
        await ProblemAssert.IsProblemAsync(unknown, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), $"{Media}/999999");
    }

    [Theory]
    [InlineData(NewsStatus.Published)]
    [InlineData(NewsStatus.Draft)]
    [InlineData(NewsStatus.Archived)]
    public async Task An_image_that_is_a_posts_cover_gets_409_and_stays(NewsStatus status)
    {
        var editor = await EditorAsync();
        var media = await UploadAsync(editor, "A cover");
        var id = media.GetProperty("id").GetInt64();
        var post = TestPosts.Item($"cover-{Guid.NewGuid():N}", status == NewsStatus.Draft ? null : TestApiClients.Now.AddDays(-1), status);
        post.CoverMediaId = id;
        await TestPosts.AddAsync(_factory.Services, post);

        var response = await editor.SendAsync(HttpMethod.Delete, $"{Media}/{id}");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), $"{Media}/{id}");
        Assert.True(File.Exists(StoredFile(media)));
        Assert.Single((await ApiClient.ReadJsonAsync(await editor.GetAsync(Media), HttpStatusCode.OK)).GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task Only_staff_and_posts_write_clients_may_delete()
    {
        var editor = await EditorAsync();
        var id = (await UploadAsync(editor, "Kept")).GetProperty("id").GetInt64();
        var path = $"{Media}/{id}";
        var (newsKey, newsSecret) = await TestApiClients.AddAsync(_factory.Services, scopes: [ApiScopes.NewsWrite]);
        var (postsKey, postsSecret) = await TestApiClients.AddAsync(_factory.Services, scopes: [ApiScopes.PostsWrite]);

        var anonymous = await _factory.CreateApiClient().SendAsync(HttpMethod.Delete, path);
        var newsClient = await TestApiClients.Http(_factory, newsKey, newsSecret).DeleteAsync(path, TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(anonymous, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), path);
        await ProblemAssert.IsProblemAsync(newsClient, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), path);
        Assert.Single((await ApiClient.ReadJsonAsync(await editor.GetAsync(Media), HttpStatusCode.OK)).GetProperty("items").EnumerateArray());

        var postsClient = await TestApiClients.Http(_factory, postsKey, postsSecret).DeleteAsync(path, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NoContent, postsClient.StatusCode);
    }

    private static async Task<JsonElement> UploadAsync(ApiClient editor, string alt) =>
        await ApiClient.ReadJsonAsync(
            await editor.Http.SendAsync(MediaUploadTests.Upload(editor, MediaUploadTests.Png(8, 4), "image.png", "image/png", alt), TestContext.Current.CancellationToken),
            HttpStatusCode.Created);

    private string StoredFile(JsonElement media) =>
        Path.Combine(_folder, new Uri(media.GetProperty("url").GetString()!).AbsolutePath["/media/".Length..]);

    private async Task<ApiClient> EditorAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));
}
