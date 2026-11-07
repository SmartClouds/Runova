using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Tests.Mapping;

public sealed class AccountAndJobMapperTests
{
    [Fact]
    public void A_device_shows_its_owner_and_whether_it_is_revoked_but_not_its_key()
    {
        var id = Guid.NewGuid();
        var device = new Device { Id = id, UserId = Guid.NewGuid(), Name = "laptop", PublicKey = [1, 2], CreatedAt = 1, LastSeenAt = 2, RevokedAt = 3 };

        Assert.Equal(new DeviceInfo(id, "alice", "laptop", 1, 2, true, false), AccountMapper.ToInfo(device, "alice", false));

        device.RevokedAt = null;
        Assert.False(AccountMapper.ToInfo(device, "alice", true).Revoked);
    }

    [Fact]
    public void A_session_shows_its_device_and_times_but_not_its_stamp()
    {
        var id = Guid.NewGuid();
        var deviceId = Guid.NewGuid();
        var session = new DeviceSession { Id = id, DeviceId = deviceId, UserId = Guid.NewGuid(), CreatedAt = 1, LastRenewedAt = 2, ExpiresAt = 3, StepUpUntil = 4, SecurityStamp = "stamp" };

        Assert.Equal(new SessionInfo(id, deviceId, "laptop", 1, 2, 3, true), AccountMapper.ToInfo(session, "laptop", true));
    }

    [Fact]
    public void A_user_takes_what_lives_elsewhere_from_the_caller()
    {
        var user = new CoreUser { Id = Guid.NewGuid(), UserName = "bob", TwoFactorEnabled = true, CreatedAt = 10, PasswordHash = "hash" };

        Assert.Equal(new UserInfo(user.Id, "bob", "Admin", true, false, 20, 30, 10, 2, true), AccountMapper.ToInfo(user, "Admin", false, 20, 30, 2, true));

        user.UserName = null;
        Assert.Equal(string.Empty, AccountMapper.ToInfo(user, null, true, null, null, 0, false).UserName);
    }

    [Fact]
    public void A_job_can_be_cancelled_only_while_it_runs_and_counts_its_live_log()
    {
        var id = Guid.NewGuid();
        var row = new Job
        {
            Id = id,
            Kind = JobKind.StackDeploy,
            Title = "Deploy shop",
            State = JobState.Running,
            Resource = "shop",
            RequestedBy = Guid.NewGuid(),
            RequestedByName = "alice",
            CreatedAt = 1,
            FinishedAt = 2,
            ExitCode = 3,
            Error = "boom",
            LogLines = 5,
            Cancellable = true,
        };

        Assert.Equal(new JobInfo(id, JobKind.StackDeploy, "Deploy shop", JobState.Running, 1, 50, true, "shop", "alice", 2, 3, "boom"), JobMapper.ToInfo(row, 50));

        row.State = JobState.Succeeded;
        Assert.False(JobMapper.ToInfo(row, 5).Cancellable);
        row.State = JobState.Running;
        row.Cancellable = false;
        Assert.False(JobMapper.ToInfo(row, 5).Cancellable);
    }

    [Fact]
    public void A_job_starts_running_with_nothing_logged()
    {
        var id = Guid.NewGuid();
        var requester = Guid.NewGuid();
        var request = new JobRequest(JobKind.StackDeploy, "Deploy shop", ["stack:shop"], "shop", requester, "alice", Cancellable: false);

        var row = JobMapper.ToRow(request, id, 1_000);

        Assert.Equal(id, row.Id);
        Assert.Equal(JobKind.StackDeploy, row.Kind);
        Assert.Equal("Deploy shop", row.Title);
        Assert.Equal(JobState.Running, row.State);
        Assert.Equal("shop", row.Resource);
        Assert.Equal(requester, row.RequestedBy);
        Assert.Equal("alice", row.RequestedByName);
        Assert.Equal(1_000, row.CreatedAt);
        Assert.False(row.Cancellable);
        Assert.Null(row.FinishedAt);
        Assert.Null(row.ExitCode);
        Assert.Null(row.Error);
        Assert.Equal(0, row.LogLines);
    }
}
