using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.Website.Api.Identity;

namespace Runova.Website.Tests.Identity;

/// <summary>
/// SignalR checks each call against the hub method's own attributes. Since .NET 11 a method with
/// no policy of its own, such as any async method, is held to the fallback policy (staff), so every
/// method a client can call names its policy, whatever the hub class says.
/// </summary>
public class HubAuthorizationTests
{
    [Fact]
    public void Every_hub_method_a_client_can_call_names_its_policy()
    {
        var methods = typeof(Policies).Assembly.GetTypes()
            .Where(t => t is { IsClass: true, IsAbstract: false } && typeof(Hub).IsAssignableFrom(t))
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Where(m => !m.IsSpecialName && m.GetBaseDefinition().DeclaringType == m.DeclaringType)
            .ToList();

        var withoutPolicy = methods
            .Where(m => !m.GetCustomAttributes<AuthorizeAttribute>().Any(a => !string.IsNullOrWhiteSpace(a.Policy)))
            .Select(m => $"{m.DeclaringType!.Name}.{m.Name}");

        Assert.NotEmpty(methods);
        Assert.Empty(withoutPolicy);
    }
}
