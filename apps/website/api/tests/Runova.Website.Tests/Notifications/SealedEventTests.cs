using Runova.Website.Api.Notifications;

namespace Runova.Website.Tests.Notifications;

/// <summary>A sealed forwarded event: a category and its copies, and no words the server can read (E92).</summary>
public class SealedEventTests
{
    private const string Key = "AbCdEfGhIjKl";

    private static SealedCopyWrite Copy(string? keyId = Key, string? content = "c2VhbGVk") => new(keyId, content);

    private static NotificationEventRequest Event(
        IReadOnlyList<SealedCopyWrite>? copies,
        string category = NotificationCategories.Deploys,
        string? status = null,
        string? agent = null,
        string? project = null,
        string? subject = null,
        string? itemId = "p1") => new(category, status, agent, project, subject, itemId, copies);

    private static (ComposedNotification? Composed, Dictionary<string, string[]> Errors) Compose(NotificationEventRequest request)
    {
        var errors = new Dictionary<string, string[]>();
        return (PushContent.Compose(request, errors), errors);
    }

    [Fact]
    public void A_sealed_event_keeps_the_generic_line_and_its_copies_and_nothing_else()
    {
        var (composed, errors) = Compose(Event([Copy()]));

        Assert.Empty(errors);
        Assert.Equal(NotificationCategories.Deploys, composed!.Category);
        Assert.Equal("New activity on your computer", composed.Line);
        Assert.Null(composed.Severity);
        Assert.Equal("p1", composed.ItemId);
        Assert.Equal([new SealedCopyDto(Key, "c2VhbGVk")], SealedCopies.Read(composed.Sealed));
    }

    [Fact]
    public void An_empty_list_is_still_sealed()
    {
        var (composed, errors) = Compose(Event([]));

        Assert.Empty(errors);
        Assert.Equal(PushContent.SealedLine, composed!.Line);
        Assert.Equal("[]", composed.Sealed);
    }

    [Fact]
    public void Without_the_property_an_event_is_a_normal_one()
    {
        var (composed, errors) = Compose(Event(null, status: "info", subject: "web-1"));

        Assert.Empty(errors);
        Assert.Equal("Notice on web-1", composed!.Line);
        Assert.Null(composed.Sealed);
    }

    [Theory]
    [InlineData("status")]
    [InlineData("agent")]
    [InlineData("project")]
    [InlineData("subject")]
    public void Plain_fields_can_not_travel_beside_a_sealed_copy(string field)
    {
        var (composed, errors) = Compose(Event(
            [Copy()],
            status: field == "status" ? "info" : null,
            agent: field == "agent" ? "Codex" : null,
            project: field == "project" ? "Shop" : null,
            subject: field == "subject" ? "web-1" : null));

        Assert.Null(composed);
        Assert.Equal([field], errors.Keys);
    }

    [Fact]
    public void A_category_that_can_not_be_forwarded_is_refused_sealed_too()
    {
        var (composed, errors) = Compose(Event([Copy()], category: NotificationCategories.Account));

        Assert.Null(composed);
        Assert.Contains("category", errors.Keys);
    }

    [Fact]
    public void Eight_copies_are_fine_and_nine_are_not()
    {
        SealedCopyWrite[] Copies(int count) => [.. Enumerable.Range(0, count).Select(i => Copy($"AbCdEfGhIj{i:D2}"))];

        Assert.Empty(Compose(Event(Copies(8))).Errors);
        Assert.Contains("sealedFor", Compose(Event(Copies(9))).Errors.Keys);
    }

    [Theory]
    [InlineData("short")]
    [InlineData("AbCdEfGhIjKlM")]
    [InlineData("AbCdEfGhIj+l")]
    [InlineData("AbCdEfGhIjK\n")]
    [InlineData(null)]
    public void A_bad_key_id_is_refused(string? keyId) =>
        Assert.Contains("sealedFor[0].keyId", Compose(Event([Copy(keyId)])).Errors.Keys);

    [Fact]
    public void A_key_id_appears_once() =>
        Assert.Contains("sealedFor[1].keyId", Compose(Event([Copy(), Copy()])).Errors.Keys);

    [Theory]
    [InlineData("")]
    [InlineData("has space")]
    [InlineData("c2VhbGVk=")]
    [InlineData("a+b/")]
    [InlineData("abcde")]
    [InlineData(null)]
    public void Bad_sealed_text_is_refused(string? content) =>
        Assert.Contains("sealedFor[0].sealed", Compose(Event([Copy(content: content)])).Errors.Keys);

    [Fact]
    public void Sealed_text_may_be_up_to_1024_characters()
    {
        Assert.Empty(Compose(Event([Copy(content: new string('a', 1024))])).Errors);
        Assert.Contains("sealedFor[0].sealed", Compose(Event([Copy(content: new string('a', 1027))])).Errors.Keys);
    }
}
