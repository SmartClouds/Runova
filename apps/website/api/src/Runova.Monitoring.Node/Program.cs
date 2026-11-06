using Runova.Monitoring.Node;

// `healthz` is the Docker healthcheck: it reads the file the node loop touches, and starts nothing.
if (args is ["healthz", ..])
{
    return Healthz.Check(Environment.GetEnvironmentVariable("NODE_DATA_PATH") is { Length: > 0 } path ? path : "/data");
}

using var host = NodeHost.Build(args);
await host.RunAsync();
return 0;
