using System.Net;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.Server.Kestrel.Https;
using Microsoft.Extensions.Options;
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Runova.Monitoring.Contracts;
using Wolverine;
using Wolverine.RabbitMQ;

namespace Runova.Monitoring.Gateway;

/// <summary>Where the server certificate comes from: the PEM files in production, a test's own in tests.</summary>
public sealed record GatewayServerCertificate(X509Certificate2 Certificate);

/// <summary>Builds the gateway, so the tests start the same app on their own ports.</summary>
public static class GatewayApp
{
    public const string RabbitMqUriKey = "RabbitMq:Uri";

    public static WebApplication Build(string[] args, Action<WebApplicationBuilder>? configure = null)
    {
        var builder = WebApplication.CreateSlimBuilder(args);
        var services = builder.Services;
        services.AddOptions<GatewayOptions>().BindConfiguration("Gateway");
        var gatewayId = builder.Configuration["Gateway:Id"] is { Length: > 0 } id
            ? id
            : $"{Environment.MachineName.ToLowerInvariant()}-{Guid.NewGuid().ToString("N")[..6]}";
        services.AddSingleton(new GatewayIdentity(gatewayId));
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<GatewayTrust>();
        services.AddSingleton<NodeSessions>();
        services.AddHostedService<TrustLoader>();
        services.AddGrpc(grpc =>
        {
            grpc.MaxReceiveMessageSize = 1024 * 1024;
            grpc.MaxSendMessageSize = 4 * 1024 * 1024;
            grpc.EnableDetailedErrors = false;
        });

        AddTelemetry(builder);
        AddWolverine(builder, gatewayId);
        configure?.Invoke(builder);

        builder.WebHost.ConfigureKestrel(kestrel =>
        {
            var options = kestrel.ApplicationServices.GetRequiredService<IOptions<GatewayOptions>>().Value;
            var trust = kestrel.ApplicationServices.GetRequiredService<GatewayTrust>();
            kestrel.AddServerHeader = false;
            kestrel.Limits.Http2.MaxStreamsPerConnection = 4;
            kestrel.Limits.Http2.KeepAlivePingDelay = TimeSpan.FromSeconds(30);
            kestrel.Limits.Http2.KeepAlivePingTimeout = TimeSpan.FromSeconds(20);
            kestrel.Limits.MaxRequestBodySize = 1024 * 1024;

            kestrel.Listen(IPAddress.IPv6Any, options.NodePort, listen =>
            {
                listen.Protocols = HttpProtocols.Http2;
                listen.UseHttps(https =>
                {
                    https.ServerCertificate = ServerCertificate(kestrel.ApplicationServices, options);
                    https.SslProtocols = SslProtocols.Tls13;
                    https.ClientCertificateMode = ClientCertificateMode.RequireCertificate;
                    https.CheckCertificateRevocation = false;
                    https.HandshakeTimeout = TimeSpan.FromSeconds(10);
                    // The chain the TLS stack built is ignored: only the Node CA counts.
                    https.ClientCertificateValidation = (certificate, _, _) => trust.Accepts(certificate, out _, out _);
                });
            });
            kestrel.Listen(IPAddress.IPv6Any, options.HealthPort, listen => listen.Protocols = HttpProtocols.Http1);
        });

        var app = builder.Build();
        // gRPC only over the node port's TLS, /healthz only over the internal plain port.
        app.MapGrpcService<NodeLinkService>().AddEndpointFilter(async (context, next) =>
            context.HttpContext.Request.IsHttps ? await next(context) : Results.NotFound());
        app.MapGet("/healthz", (HttpContext http, GatewayTrust trust, NodeSessions sessions) =>
            http.Request.IsHttps
                ? Results.NotFound()
                : trust.Ready
                    ? Results.Ok(new { status = "ready", nodes = sessions.Count })
                    : Results.Json(new { status = "loading" }, statusCode: StatusCodes.Status503ServiceUnavailable));
        return app;
    }

    private static X509Certificate2 ServerCertificate(IServiceProvider services, GatewayOptions options)
    {
        if (services.GetService<GatewayServerCertificate>() is { } given)
        {
            return given.Certificate;
        }

        if (string.IsNullOrWhiteSpace(options.ServerCertificatePath) || string.IsNullOrWhiteSpace(options.ServerKeyPath))
        {
            throw new InvalidOperationException("Set Gateway__ServerCertificatePath and Gateway__ServerKeyPath to the PEM files for the node address.");
        }

        // Re-imported so Windows keeps the key usable for TLS; harmless elsewhere.
        using var pem = X509Certificate2.CreateFromPemFile(options.ServerCertificatePath, options.ServerKeyPath);
        return X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pkcs12), null);
    }

    private static void AddWolverine(WebApplicationBuilder builder, string gatewayId)
    {
        var rabbit = builder.Configuration[RabbitMqUriKey];
        if (string.IsNullOrWhiteSpace(rabbit))
        {
            // Tests give their own link; a real gateway has nothing to do without the broker.
            if (builder.Environment.IsProduction())
            {
                throw new InvalidOperationException("Set RabbitMq__Uri to the internal RabbitMQ.");
            }

            return;
        }

        builder.Services.AddSingleton<IApiLink, WolverineApiLink>();
        builder.Host.UseWolverine(options =>
        {
            options.ServiceName = "runova-monitoring-gateway";
            options.ApplicationAssembly = typeof(GatewayApp).Assembly;
            options.Discovery.DisableConventionalDiscovery().IncludeType(typeof(GatewayInboundHandler));

            // Each gateway has its own queue on the API's fanout exchange. RabbitMQ 4 has no transient
            // shared queues, so it is durable but goes away 10 minutes after its gateway does, and a
            // message for a node older than a minute is dropped: the node has a new snapshot by then.
            var queue = $"{MonitoringQueues.ToGateways}-{gatewayId}";
            var transport = options.UseRabbitMq(new Uri(rabbit)).AutoProvision();
            transport.DeclareExchange(MonitoringQueues.ToGateways, exchange =>
            {
                exchange.ExchangeType = ExchangeType.Fanout;
                exchange.IsDurable = true;
            });
            transport.BindExchange(MonitoringQueues.ToGateways, ExchangeType.Fanout).ToQueue(queue);
            // The API's queue is declared here too: RabbitMQ confirms a message it can not route,
            // so a batch sent before the API ever started would be acked and lost.
            transport.DeclareQueue(MonitoringQueues.ToApi);
            options.ListenToRabbitQueue(queue, q =>
            {
                q.IsDurable = true;
                q.AutoDelete = false;
                q.Arguments["x-expires"] = 600_000;
                q.Arguments["x-message-ttl"] = 60_000;
            });

            // Inline: sent at once, never held in a local queue on this stateless gateway.
            options.PublishMessage<NodeConnected>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
            options.PublishMessage<NodeHeartbeat>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
            options.PublishMessage<NodeDisconnected>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
            options.PublishMessage<CheckResultBatch>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
            options.PublishMessage<RenewNodeCertificate>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
            options.PublishMessage<GetNodeTrust>().ToRabbitQueue(MonitoringQueues.ToApi).SendInline();
        });
    }

    private static void AddTelemetry(WebApplicationBuilder builder)
    {
        builder.WebHost.UseSentry(options =>
        {
            options.Dsn ??= string.Empty;
            options.SendDefaultPii = false;
            options.MaxRequestBodySize = Sentry.Extensibility.RequestSize.None;
            options.UseOtlp();
        });

        var name = builder.Configuration["OTEL_SERVICE_NAME"] is { Length: > 0 } configured ? configured : "runova-monitoring-gateway";
        var telemetry = builder.Services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService(name))
            .WithTracing(tracing => tracing
                .AddAspNetCoreInstrumentation()
                .AddSource("Wolverine"));
        if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
        {
            telemetry.UseOtlpExporter();
        }
    }
}
