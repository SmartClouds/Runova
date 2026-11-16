using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Runova.Website.Api.Problems;

internal static class ProblemDetailsSetup
{
    /// <summary>Problem details for every error, written by <see cref="ProblemJsonWriter"/>.</summary>
    public static IServiceCollection AddWebsiteProblemDetails(this IServiceCollection services)
    {
        services.AddSingleton<IProblemDetailsWriter, ProblemJsonWriter>();
        return services.AddProblemDetails();
    }

    /// <summary>
    /// Unhandled exceptions answer <c>internal</c> with no detail (Development keeps the developer
    /// page), and an empty error response, such as a 404 for an unknown route or a 405, gets a
    /// problem details body.
    /// </summary>
    public static WebApplication UseWebsiteProblemDetails(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment())
        {
            app.UseExceptionHandler();
        }

        app.UseStatusCodePages();
        return app;
    }

    /// <summary>
    /// An OpenAPI operation transformer. Since .NET 11, results such as <c>UnauthorizedHttpResult</c>
    /// add their status to the document with no body, but the status code pages above answer them
    /// with problem details, so the document says so.
    /// </summary>
    public static async Task DescribeEmptyErrors(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken cancellationToken)
    {
        var empty = operation.Responses?
            .Where(r => int.TryParse(r.Key, out var status) && status >= 400 && r.Value is OpenApiResponse { Content: null or { Count: 0 } })
            .Select(r => (OpenApiResponse)r.Value)
            .ToList();
        if (empty is not { Count: > 0 } || context.Document is not { } document)
        {
            return;
        }

        if (document.Components?.Schemas?.ContainsKey(ProblemSchema) != true)
        {
            document.AddComponent(ProblemSchema, await context.GetOrCreateSchemaAsync(typeof(ProblemDetails), null, cancellationToken));
        }

        foreach (var response in empty)
        {
            response.Content = new Dictionary<string, IOpenApiMediaType>
            {
                ["application/problem+json"] = new OpenApiMediaType { Schema = new OpenApiSchemaReference(ProblemSchema, document) },
            };
        }
    }

    private const string ProblemSchema = nameof(ProblemDetails);
}
