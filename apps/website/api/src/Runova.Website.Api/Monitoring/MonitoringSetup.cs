using JasperFx.CodeGeneration.Model;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.Monitoring.Contracts;
using Runova.Website.Data;
using Wolverine;
using Wolverine.Postgresql;
using Wolverine.RabbitMQ;

namespace Runova.Website.Api.Monitoring;

/// <summary>
/// Monitoring nodes (E54). The gateways reach the API only through Wolverine on the internal
/// RabbitMQ (<c>RabbitMq__Uri</c>), which has no published port. Without that setting the API runs
/// without Wolverine: the admin pages and enrollment still work, and no gateway is told anything.
/// </summary>
internal static class MonitoringSetup
{
    public const string RabbitMqUriKey = "RabbitMq:Uri";

    public static WebApplicationBuilder AddWebsiteMonitoring(this WebApplicationBuilder builder)
    {
        var services = builder.Services;
        services.AddOptions<MonitoringOptions>().BindConfiguration("Monitoring");
        services.AddScoped<NodeCertificateAuthority>();
        services.AddScoped<NodeEvents>();
        services.AddScoped<NodeLivenessJob>();
        services.TryAddScoped<IAssignmentSource, NoAssignments>();
        services.TryAddScoped<IResultIngestor, DropResults>();
        services.TryAddScoped<INodeRebalancer, NoRebalance>();

        var rabbit = builder.Configuration[RabbitMqUriKey];
        if (string.IsNullOrWhiteSpace(rabbit))
        {
            services.TryAddSingleton<INodeBus, NullNodeBus>();
            return builder;
        }

        services.TryAddScoped<INodeBus, WolverineNodeBus>();
        var connectionString = builder.Configuration.GetConnectionString(DataServiceCollectionExtensions.ConnectionStringName)
            ?? throw new InvalidOperationException("ConnectionStrings__Default is required with RabbitMq__Uri.");
        builder.Host.UseWolverine(options =>
        {
            options.ServiceName = "runova-website-api";
            options.ApplicationAssembly = typeof(MonitoringSetup).Assembly;
            // Only the node handlers: nothing else in the API becomes a message handler by its name.
            options.Discovery.DisableConventionalDiscovery().IncludeType(typeof(NodeMessageHandler));
            // The handlers ask for scoped services the API registers with factories (the DbContext
            // among them), which Wolverine can only get from the message's own scope.
            options.ServiceLocationPolicy = ServiceLocationPolicy.AlwaysAllowed;

            options.UseRabbitMq(new Uri(rabbit))
                .AutoProvision()
                .DeclareExchange(MonitoringQueues.ToGateways, exchange =>
                {
                    exchange.ExchangeType = ExchangeType.Fanout;
                    exchange.IsDurable = true;
                });
            options.ListenToRabbitQueue(MonitoringQueues.ToApi);
            options.PublishMessage<NodeOutbound>().ToRabbitExchange(MonitoringQueues.ToGateways);
            options.PublishMessage<NodeRevoked>().ToRabbitExchange(MonitoringQueues.ToGateways);
            options.PublishMessage<CloseNodeConnection>().ToRabbitExchange(MonitoringQueues.ToGateways);

            // What the API sends waits in Postgres until RabbitMQ has it, and what it receives is
            // kept there until handled, so neither side loses a message to a restart.
            options.PersistMessagesWithPostgresql(connectionString, "wolverine");
            options.Policies.UseDurableOutboxOnAllSendingEndpoints();
            options.Policies.UseDurableInboxOnAllListeners();
        });
        return builder;
    }

    public static RouteGroupBuilder MapMonitoring(this RouteGroupBuilder api) => api.MapMonitoringNodes();
}
