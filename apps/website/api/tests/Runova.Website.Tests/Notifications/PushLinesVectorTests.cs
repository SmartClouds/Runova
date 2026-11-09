using System.Text.Json;
using Runova.Website.Api.Notifications;

namespace Runova.Website.Tests.Notifications;

/// <summary>
/// The computer writes a sealed line from the same templates the server uses (E92), so both replay
/// packages/protocol/test-vectors/push-lines-v1.json and have to come out the same.
/// </summary>
public class PushLinesVectorTests
{
    private static string? Text(JsonElement item, string name) => item.GetProperty(name).GetString();

    [Fact]
    public void Every_recorded_line_is_the_line_the_server_writes()
    {
        using var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Vectors", "push-lines-v1.json")));
        var cases = vectors.RootElement.GetProperty("cases").EnumerateArray().ToList();

        var wrong = new List<string>();
        foreach (var item in cases)
        {
            var errors = new Dictionary<string, string[]>();
            var request = new NotificationEventRequest(Text(item, "category"), Text(item, "status"), Text(item, "agent"), Text(item, "project"), Text(item, "subject"), null);
            var composed = PushContent.Compose(request, errors);
            if (composed?.Line != Text(item, "line"))
            {
                wrong.Add($"{Text(item, "category")}/{Text(item, "status")}: expected '{Text(item, "line")}', got '{composed?.Line}' {string.Join(",", errors.Keys)}");
            }
        }

        Assert.NotEmpty(cases);
        Assert.Empty(wrong);
    }
}
