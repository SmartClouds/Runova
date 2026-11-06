using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Billing;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Billing;

namespace Runova.Website.Api.Billing;

/// <summary>
/// An account's plan as its Plan page shows it: the type it has now (Free when nothing else), the
/// subscription behind it, and how it can pay. <c>canManageCard</c> is whether it ever paid by card.
/// </summary>
public sealed record AccountPlanDto(
    AccountTypeDto AccountType,
    SubscriptionDto? Subscription,
    bool CardPayments,
    bool CryptoPayments,
    IReadOnlyList<int> CryptoMonths,
    bool CanManageCard);

public sealed record PaymentDto(
    long Id,
    string Provider,
    long AccountTypeId,
    string AccountTypeName,
    int? Months,
    long AmountCents,
    string Currency,
    string Status,
    string? ProviderStatus,
    string? InvoiceUrl,
    DateTimeOffset CreatedAt,
    DateTimeOffset? PaidAt);

/// <summary>A payment as an Admin sees it, with whose it is.</summary>
public sealed record AdminPaymentDto(
    long Id,
    long UserId,
    string? Email,
    string Provider,
    string OrderId,
    long AccountTypeId,
    string AccountTypeName,
    int? Months,
    long AmountCents,
    string Currency,
    string Status,
    string? ProviderStatus,
    DateTimeOffset CreatedAt,
    DateTimeOffset? PaidAt);

/// <summary>An Admin's grant: a type, and the day it ends (none for no end).</summary>
public sealed record SubscriptionGrantRequest(long? AccountTypeId, DateTimeOffset? EndsAt);

/// <summary>A user's plan as the admin user page shows it.</summary>
public sealed record UserPlanDto(AccountTypeDto AccountType, SubscriptionDto? Subscription);

internal static class SubscriptionEndpoints
{
    public static RouteGroupBuilder MapSubscriptions(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/accounts/me").RequireAuthorization(Policies.Account);
        me.MapGet("/subscriptions/current", GetMineAsync);
        me.MapGet("/payments", ListMineAsync);

        var users = api.MapGroup("/users/{id:long}/subscriptions/current").RequireAuthorization(Policies.Admin);
        users.MapGet("", GetForUserAsync);
        users.MapPut("", GrantAsync);
        users.MapDelete("", RemoveAsync);

        api.MapGet("/payments", ListAllAsync).RequireAuthorization(Policies.Admin);
        return api;
    }

    private static async Task<Ok<AccountPlanDto>> GetMineAsync(HttpContext http, AppDbContext db, SubscriptionBook book, PaymentSettingsStore store)
    {
        var userId = CurrentAccount.Id(http);
        var (type, subscription) = await PlanAsync(db, book, userId, http.RequestAborted);
        var config = await store.GetAsync(http.RequestAborted);
        var hasCustomer = await db.BillingCustomers.AnyAsync(c => c.UserId == userId);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new AccountPlanDto(
            BillingMapper.ToDto(type),
            subscription is null ? null : BillingMapper.ToDto(subscription),
            config.StripeReady,
            config.NowPaymentsReady,
            config.CryptoMonths,
            hasCustomer && config.StripeSecretKey is not null));
    }

    private static async Task<Results<Ok<Page<PaymentDto>>, ValidationProblem>> ListMineAsync(int? page, int? pageSize, HttpContext http, AppDbContext db)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var userId = CurrentAccount.Id(http);
        var mine = db.Payments.AsNoTracking().Where(p => p.UserId == userId);
        var total = await mine.CountAsync();
        var rows = await (from p in mine
                          join t in db.AccountTypes on p.AccountTypeId equals t.Id
                          orderby p.CreatedAt descending, p.Id descending
                          select new PaymentDto(
                              p.Id, p.Provider, p.AccountTypeId, t.Name, p.Months, p.AmountCents, p.Currency, p.Status, p.ProviderStatus,
                              p.Status == PaymentStatuses.Pending ? p.InvoiceUrl : null, p.CreatedAt, p.PaidAt))
            .Skip(request.Skip).Take(request.Size).ToListAsync();
        var result = Page.Of(rows, request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }

    private static async Task<Results<Ok<UserPlanDto>, ProblemHttpResult>> GetForUserAsync(long id, HttpContext http, AppDbContext db, SubscriptionBook book)
    {
        if (!await db.Users.AnyAsync(u => u.Id == id))
        {
            return NoSuchUser();
        }

        var (type, subscription) = await PlanAsync(db, book, id, http.RequestAborted);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(new UserPlanDto(BillingMapper.ToDto(type), subscription is null ? null : BillingMapper.ToDto(subscription)));
    }

    /// <summary>
    /// Gives an account a type, replacing any prepaid one. A card subscription has to be canceled
    /// in Stripe first, or Stripe would go on charging for it.
    /// </summary>
    private static async Task<Results<Ok<UserPlanDto>, ValidationProblem, ProblemHttpResult>> GrantAsync(
        long id, SubscriptionGrantRequest request, HttpContext http, AppDbContext db, SubscriptionBook book, AuditLog audit,
        IPlanEnforcement enforcement, BillingNotices notices, TimeProvider time)
    {
        if (!await db.Users.AnyAsync(u => u.Id == id))
        {
            return NoSuchUser();
        }

        var errors = new Dictionary<string, string[]>();
        var type = request.AccountTypeId is { } typeId ? await db.AccountTypes.SingleOrDefaultAsync(t => t.Id == typeId) : null;
        if (type is null || type.IsFree)
        {
            errors["accountTypeId"] = ["Give an account type that is not free. To take a type away, delete the subscription."];
        }

        if (request.EndsAt is { } endsAt && endsAt <= time.GetUtcNow())
        {
            errors["endsAt"] = ["Give a time in the future, or null for no end."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (await book.CurrentAsync(id, http.RequestAborted) is { Provider: BillingProviders.Stripe })
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "This account pays by card. Cancel that subscription in Stripe first.");
        }

        var subscription = await book.GrantAsync(id, type!, request.EndsAt, CurrentAccount.Id(http), http.RequestAborted);
        await db.SaveChangesAsync();
        audit.Add(AuditActions.SubscriptionAssign, AuditTargetTypes.Subscription, subscription.Id, new { userId = id, accountType = type!.Key, endsAt = request.EndsAt });
        var until = request.EndsAt is { } end ? $" until {end:d MMMM yyyy}" : "";
        await notices.AddAsync(id, $"You are on {type.Name}", $"Runova gave this account {type.Name}{until}.", cancellationToken: http.RequestAborted);
        await db.SaveChangesAsync();
        await notices.FlushAsync();
        await enforcement.AccountChangedAsync(id, http.RequestAborted);
        return TypedResults.Ok(new UserPlanDto(BillingMapper.ToDto(type), BillingMapper.ToDto(subscription)));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> RemoveAsync(
        long id, HttpContext http, AppDbContext db, SubscriptionBook book, AuditLog audit, IPlanEnforcement enforcement)
    {
        if (await book.CurrentAsync(id, http.RequestAborted) is not { } current)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "This account has no subscription.");
        }

        if (current.Provider == BillingProviders.Stripe)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "This account pays by card. Cancel that subscription in Stripe; this page follows.");
        }

        book.End(current, SubscriptionStatuses.Canceled);
        audit.Add(AuditActions.SubscriptionRemove, AuditTargetTypes.Subscription, current.Id, new { userId = id });
        await db.SaveChangesAsync();
        await enforcement.AccountChangedAsync(id, http.RequestAborted);
        return TypedResults.NoContent();
    }

    private static async Task<Results<Ok<Page<AdminPaymentDto>>, ValidationProblem>> ListAllAsync(
        int? page, int? pageSize, long? userId, string? status, HttpContext http, AppDbContext db)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (status is not null && status is not (PaymentStatuses.Pending or PaymentStatuses.Paid or PaymentStatuses.Failed or PaymentStatuses.Expired))
        {
            errors["status"] = ["status is pending, paid, failed or expired."];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var query = db.Payments.AsNoTracking().Where(p => (userId == null || p.UserId == userId) && (status == null || p.Status == status));
        var total = await query.CountAsync();
        var rows = await (from p in query
                          join t in db.AccountTypes on p.AccountTypeId equals t.Id
                          join u in db.Users on p.UserId equals u.Id
                          orderby p.CreatedAt descending, p.Id descending
                          select new AdminPaymentDto(
                              p.Id, p.UserId, u.Email, p.Provider, p.OrderId, p.AccountTypeId, t.Name, p.Months, p.AmountCents, p.Currency,
                              p.Status, p.ProviderStatus, p.CreatedAt, p.PaidAt))
            .Skip(request.Skip).Take(request.Size).ToListAsync();
        var result = Page.Of(rows, request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }

    private static async Task<(AccountType Type, Subscription? Subscription)> PlanAsync(AppDbContext db, SubscriptionBook book, long userId, CancellationToken cancellationToken)
    {
        var subscription = await book.CurrentAsync(userId, cancellationToken);
        var type = subscription is null
            ? await db.AccountTypes.AsNoTracking().SingleAsync(t => t.IsFree, cancellationToken)
            : await db.AccountTypes.AsNoTracking().SingleAsync(t => t.Id == subscription.AccountTypeId, cancellationToken);
        return (type, subscription);
    }

    private static ProblemHttpResult NoSuchUser() => ApiProblems.Of(ProblemTypes.NotFound, "There is no such user.");
}
