using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests;

/// <summary>
/// The OpenAPI document the API serves, held to the conventions of docs/website/api-contract.md.
/// The theories below show each check catching what it is there to catch.
/// </summary>
public sealed class ApiConventionTests(PostgresFixture postgres)
{
    private static readonly string _contractPath = Path.Combine(AppContext.BaseDirectory, "Contract", "api-contract.md");

    [Fact]
    public async Task Every_path_is_a_plural_noun_under_api_v1()
    {
        var document = await OpenApiDocumentAsync();

        var paths = document.GetProperty("paths").EnumerateObject().Select(p => p.Name).ToList();

        Assert.NotEmpty(paths);
        Assert.Empty(paths.SelectMany(ApiConventions.PathProblems));
    }

    [Fact]
    public async Task Every_error_response_is_problem_details()
    {
        var document = await OpenApiDocumentAsync();

        Assert.Empty(ApiConventions.ErrorResponseProblems(document));
    }

    [Fact]
    public async Task Every_operation_and_status_code_is_one_the_contract_lists()
    {
        var document = await OpenApiDocumentAsync();
        var contract = ApiConventions.ReadContract(await File.ReadAllTextAsync(_contractPath, TestContext.Current.CancellationToken));

        Assert.Empty(ApiConventions.ContractProblems(document, contract));
    }

    [Fact]
    public async Task The_contract_tables_are_read_in_full()
    {
        var contract = ApiConventions.ReadContract(await File.ReadAllTextAsync(_contractPath, TestContext.Current.CancellationToken));

        Assert.Equal([200, 304, 400], contract["GET /api/v1/news"].Order());
        Assert.Equal([201, 400, 401, 403, 409, 422, 429], contract["POST /api/v1/news"].Order());
        Assert.Equal([302, 404, 503], contract["GET /api/v1/releases/latest/downloads/{platform}"].Order());
        Assert.Equal([200, 400, 401, 403], contract["GET /api/v1/audit-entries"].Order());
    }

    [Theory]
    [InlineData("/api/v1/news")]
    [InlineData("/api/v1/news/{id}")]
    [InlineData("/api/v1/users/me/two-factor")]
    [InlineData("/api/v1/api-clients/{id}/secrets")]
    [InlineData("/api/v1/releases/latest/downloads/{platform}")]
    [InlineData("/api/v1/csrf-tokens/current")]
    public void A_plural_noun_or_fixed_segment_passes(string path) =>
        Assert.Empty(ApiConventions.PathProblems(path));

    [Theory]
    [InlineData("/api/v2/news")]
    [InlineData("/api/news")]
    [InlineData("/health/live")]
    [InlineData("/api/v1/news/{id}/publish")]
    [InlineData("/api/v1/user/{id}")]
    [InlineData("/api/v1/api-client")]
    [InlineData("/api/v1/process")]
    [InlineData("/api/v1/Users")]
    [InlineData("/api/v1/sessions/login")]
    public void A_path_that_is_not_a_plural_noun_under_api_v1_fails(string path) =>
        Assert.NotEmpty(ApiConventions.PathProblems(path));

    [Theory]
    [InlineData("""{ "content": { "application/json": { "schema": { "$ref": "#/components/schemas/NewsItemDto" } } } }""")]
    [InlineData("""{ "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/NewsItemDto" } } } }""")]
    [InlineData("""{ "content": { "application/problem+json": { "schema": { "type": "object" } } } }""")]
    [InlineData("""{ "description": "Not Found" }""")]
    public void An_error_response_that_is_not_problem_details_fails(string response)
    {
        using var document = JsonDocument.Parse($$"""{ "paths": { "/api/v1/news": { "get": { "responses": { "200": { }, "404": {{response}} } } } } }""");

        Assert.Single(ApiConventions.ErrorResponseProblems(document.RootElement));
    }

    [Theory]
    [InlineData("#/components/schemas/ProblemDetails")]
    [InlineData("#/components/schemas/HttpValidationProblemDetails")]
    public void A_problem_details_error_response_passes(string schema)
    {
        using var document = JsonDocument.Parse($$"""{ "paths": { "/api/v1/news": { "get": { "responses": { "400": { "content": { "application/problem+json": { "schema": { "$ref": "{{schema}}" } } } } } } } } }""");

        Assert.Empty(ApiConventions.ErrorResponseProblems(document.RootElement));
    }

    [Fact]
    public void An_operation_or_status_code_the_contract_does_not_list_fails()
    {
        var contract = new Dictionary<string, IReadOnlySet<int>> { ["GET /api/v1/news"] = new HashSet<int> { 200, 400 } };
        using var document = JsonDocument.Parse("""
            { "paths": {
              "/api/v1/news": { "get": { "responses": { "200": { }, "304": { }, "302": { } } }, "post": { "responses": { "201": { } } } }
            } }
            """);

        Assert.Equal(
            ["GET /api/v1/news documents 302, which the contract does not list", "POST /api/v1/news is not in the contract"],
            ApiConventions.ContractProblems(document.RootElement, contract));
    }

    private async Task<JsonElement> OpenApiDocumentAsync()
    {
        using var factory = new WebsiteApiFactory(postgres.ConnectionString);
        var json = await factory.CreateClient().GetStringAsync("/openapi/v1.json", TestContext.Current.CancellationToken);
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
