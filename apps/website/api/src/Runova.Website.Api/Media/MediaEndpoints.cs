using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Media;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;

namespace Runova.Website.Api.Media;

/// <summary>
/// Images for posts, for Editors, Admins and API clients with <c>posts:write</c>: upload, list and
/// delete. The type comes from the file's leading bytes, never its name or part type, and what is
/// stored is re-encoded without metadata (see <see cref="MediaImages"/>). An image that a post
/// uses as its cover can not be deleted.
/// </summary>
internal static class MediaEndpoints
{
    // Room for the multipart boundaries and the alt text around a file at the limit.
    private const long FormOverhead = 64 * 1024;

    public static IServiceCollection AddWebsiteMedia(this IServiceCollection services) => services.AddSingleton<MediaStorage>();

    public static RouteGroupBuilder MapMedia(this RouteGroupBuilder api)
    {
        api.MapPost("/media", UploadAsync)
            .RequireAuthorization(Policies.PostsWrite)
            .Accepts<IFormFile>("multipart/form-data")
            .WithMetadata(Idempotent.Instance, new RequestSizeLimitAttribute(MediaImages.MaxBytes + FormOverhead));
        api.MapGet("/media", ListAsync).RequireAuthorization(Policies.PostsWrite);
        api.MapDelete("/media/{id:long}", DeleteAsync).RequireAuthorization(Policies.PostsWrite);
        return api;
    }

    /// <summary>Every image, newest first.</summary>
    private static async Task<Results<Ok<Page<MediaDto>>, ValidationProblem>> ListAsync(
        int? page, int? pageSize, AppDbContext db, IConfiguration configuration, HttpContext http)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var total = await db.Media.CountAsync();
        var files = await db.Media.AsNoTracking()
            .OrderByDescending(m => m.CreatedAt).ThenByDescending(m => m.Id)
            .Skip(request.Skip).Take(request.Size)
            .ToListAsync();

        var siteUrl = SiteUrl.From(configuration);
        var result = Page.Of([.. files.Select(f => MediaMapper.ToDto(f, MediaStorage.Url(siteUrl, f)))], request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }

    /// <summary>
    /// Deletes the row and then the file. A post that takes the image as its cover in the
    /// meantime is caught by the foreign key, and answers the same 409.
    /// </summary>
    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteAsync(
        long id, AppDbContext db, AuditLog audit, MediaStorage storage)
    {
        if (await db.Media.FindAsync(id) is not { } media)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such image.");
        }

        if (await db.Posts.AnyAsync(p => p.CoverMediaId == id))
        {
            return InUse();
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        db.Media.Remove(media);
        audit.Add(AuditActions.MediaDelete, AuditTargetTypes.Media, media.Id, new { path = media.Path });
        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.ForeignKeyViolation })
        {
            return InUse();
        }

        await transaction.CommitAsync();
        storage.Delete(media.Path);
        return TypedResults.NoContent();
    }

    private static ProblemHttpResult InUse() =>
        ApiProblems.Of(ProblemTypes.Conflict, "A post uses this image as its cover. Give the post another cover first.");

    private static async Task<Results<Created<MediaDto>, ValidationProblem, ProblemHttpResult>> UploadAsync(
        HttpContext http, AppDbContext db, AuditLog audit, MediaStorage storage, TimeProvider time, IConfiguration configuration)
    {
        var errors = new Dictionary<string, string[]>();
        if (!http.Request.HasFormContentType)
        {
            errors["file"] = ["Send the image as multipart/form-data, in a part named file."];
            return ApiProblems.Invalid(errors);
        }

        IFormCollection form;
        try
        {
            form = await http.Request.ReadFormAsync(http.RequestAborted);
        }
        catch (BadHttpRequestException e) when (e.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return TooLarge();
        }
        catch (InvalidDataException)
        {
            errors["file"] = ["The multipart body could not be read."];
            return ApiProblems.Invalid(errors);
        }

        var file = form.Files.GetFile("file");
        if (file?.Length > MediaImages.MaxBytes)
        {
            return TooLarge();
        }

        if (file is null)
        {
            errors["file"] = ["Send the image in a part named file."];
        }

        var alt = form["alt"].ToString().Trim();
        if (alt.Length is < 1 or > 200)
        {
            errors["alt"] = ["Describe the image in 1 to 200 characters."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        using var buffer = new MemoryStream();
        await file!.CopyToAsync(buffer, http.RequestAborted);
        if (MediaImages.Process(buffer.ToArray(), out var error) is not { } image)
        {
            errors["file"] = [error!];
            return ApiProblems.Invalid(errors);
        }

        var now = time.GetUtcNow();
        var (creatorKind, creatorId) = AuditLog.Actor(http.User);
        var media = new MediaFile
        {
            Path = await storage.SaveAsync(image, now, http.RequestAborted),
            ContentType = image.ContentType,
            Width = image.Width,
            Height = image.Height,
            Size = image.Bytes.Length,
            Alt = alt,
            CreatedAt = now,
            CreatedByKind = creatorKind,
            CreatedById = creatorId,
        };

        try
        {
            await using var transaction = await db.Database.BeginTransactionAsync();
            db.Media.Add(media);
            await db.SaveChangesAsync();
            audit.Add(AuditActions.MediaUpload, AuditTargetTypes.Media, media.Id, new { path = media.Path, contentType = media.ContentType });
            await db.SaveChangesAsync();
            await transaction.CommitAsync();
        }
        catch
        {
            storage.Delete(media.Path);
            throw;
        }

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Created($"{ApiV1.Prefix}/media/{media.Id}", MediaMapper.ToDto(media, MediaStorage.Url(SiteUrl.From(configuration), media)));
    }

    private static ProblemHttpResult TooLarge() =>
        ApiProblems.Of(ProblemTypes.PayloadTooLarge, $"An upload is at most {MediaImages.MaxBytes / 1024 / 1024} MB.");
}
