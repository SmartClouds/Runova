using Runova.Monitoring.Gateway;

var app = GatewayApp.Build(args);
await app.RunAsync();
