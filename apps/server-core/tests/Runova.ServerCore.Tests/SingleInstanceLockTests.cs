using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Tests;

/// <summary>Only one core serves from a state folder at a time.</summary>
public sealed class SingleInstanceLockTests
{
    [Fact]
    public void A_second_core_on_the_same_state_stops()
    {
        var folder = TestFolders.Create("instance-lock");
        try
        {
            using (SingleInstanceLock.Acquire(folder))
            {
                var error = Assert.Throws<InvalidOperationException>(() => SingleInstanceLock.Acquire(folder));
                Assert.Contains("Another server core", error.Message, StringComparison.Ordinal);
            }

            // Released with the first, so a restart takes it again.
            SingleInstanceLock.Acquire(folder).Dispose();
        }
        finally
        {
            TestFolders.Delete(folder);
        }
    }
}
