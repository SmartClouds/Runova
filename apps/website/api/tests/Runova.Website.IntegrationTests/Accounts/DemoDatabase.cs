using System.Net.Http.Headers;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>
/// Proof that the demo account leaves the database alone: the rows of every table, counted before
/// and after, and the data-changing commands the API sent in between.
/// </summary>
internal sealed class DemoDatabase(string connectionString, DatabaseWrites writes)
{
    private IReadOnlyDictionary<string, long> _rows = new Dictionary<string, long>();
    private int _writes;

    /// <summary>
    /// Starts the host and makes the Data Protection key every token is sealed with, since the
    /// first one is written to the database, then notes where things stand.
    /// </summary>
    public async Task ReadyAsync(WebsiteApiFactory factory)
    {
        factory.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector("warm-up").Protect("x");
        await MarkAsync();
    }

    public async Task MarkAsync()
    {
        _rows = await CountAsync();
        _writes = writes.Count;
    }

    public async Task AssertUnchangedAsync()
    {
        Assert.Equal(_writes, writes.Count);
        Assert.Equal(_rows, await CountAsync());
    }

    private async Task<IReadOnlyDictionary<string, long>> CountAsync()
    {
        var cancel = TestContext.Current.CancellationToken;
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancel);
        var tables = new List<string>();
        await using (var list = new NpgsqlCommand(
            "SELECT format('%I.%I', table_schema, table_name) FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1",
            connection))
        await using (var reader = await list.ExecuteReaderAsync(cancel))
        {
            while (await reader.ReadAsync(cancel))
            {
                tables.Add(reader.GetString(0));
            }
        }

        var counts = new SortedDictionary<string, long>(StringComparer.Ordinal);
        foreach (var table in tables)
        {
            await using var count = new NpgsqlCommand($"SELECT count(*) FROM {table}", connection);
            counts[table] = (long)(await count.ExecuteScalarAsync(cancel))!;
        }

        return counts;
    }
}

internal static class DemoRequests
{
    public const string Tokens = "/api/v1/device-tokens";

    public static object Grant(string platform = "android") => new
    {
        grantType = "demo",
        platform,
        appVersion = "4.2.0",
        deviceId = Guid.NewGuid(),
    };

    public static object Refresh(string refreshToken) => new
    {
        grantType = "refresh_token",
        code = (string?)null,
        codeVerifier = (string?)null,
        redirectUri = (string?)null,
        refreshToken,
    };

    public static HttpClient Bearer(WebsiteApiFactory factory, string accessToken)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return client;
    }
}
