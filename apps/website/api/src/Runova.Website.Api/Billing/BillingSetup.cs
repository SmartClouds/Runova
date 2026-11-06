namespace Runova.Website.Api.Billing;

internal static class BillingSetup
{
    /// <summary>Account types and payments (E53): Stripe, NOWPayments, entitlements and the plan jobs.</summary>
    public static IServiceCollection AddWebsiteBilling(this IServiceCollection services)
    {
        services.AddOptions<BillingOptions>().BindConfiguration("Billing");
        services.AddHttpClient(StripeGateway.HttpClientName, http => http.Timeout = TimeSpan.FromSeconds(30))
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
        services.AddHttpClient<NowPaymentsClient>(http =>
            {
                http.Timeout = TimeSpan.FromSeconds(30);
                http.DefaultRequestHeaders.UserAgent.ParseAdd("Runova-Website/1.0 (+https://runovahq.com)");
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });

        services.AddSingleton<PaymentSecrets>();
        services.AddScoped<PaymentSettingsStore>();
        services.AddSingleton<StripeGateway>();
        services.AddScoped<Entitlements>();
        services.AddScoped<SubscriptionBook>();
        services.AddScoped<BillingNotices>();
        services.AddScoped<SubscriptionExpiryJob>();
        services.AddScoped<RenewalReminderJob>();
        services.AddScoped<IPlanEnforcement, NoPlanEnforcement>();
        return services;
    }

    public static RouteGroupBuilder MapBilling(this RouteGroupBuilder api)
    {
        api.MapAccountTypes();
        api.MapPaymentSettings();
        api.MapCheckout();
        api.MapSubscriptions();
        return api;
    }
}
