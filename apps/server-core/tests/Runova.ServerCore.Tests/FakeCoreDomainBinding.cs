using System.Globalization;
using Runova.ServerCore.CoreDomain;

namespace Runova.ServerCore.Tests;

/// <summary>Reads what the core domain's endpoint asks Kestrel for, since the in-memory test server binds nothing.</summary>
internal sealed class FakeCoreDomainBinding(CoreDomainEndpoint endpoint) : ICoreDomainBinding
{
    public bool IsListening(int port) =>
        endpoint.TryGet($"Kestrel:Endpoints:{CoreDomainEndpoint.Name}:Url", out var url)
        && url == string.Create(CultureInfo.InvariantCulture, $"http://127.0.0.1:{port}");
}
