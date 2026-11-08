using Runova.Website.Api.Remote;

namespace Runova.Website.Tests.Remote;

public class RemoteRelayTicketsTests
{
    private readonly ManualTime _time = new(new DateTimeOffset(2026, 11, 8, 9, 0, 0, TimeSpan.Zero));

    [Fact]
    public void A_ticket_is_unguessable_and_names_its_session_and_side()
    {
        var tickets = new RemoteRelayTickets(_time);

        var host = tickets.Issue("session-1", RelaySide.Host);
        var controller = tickets.Issue("session-1", RelaySide.Controller);

        Assert.Matches("^[A-Za-z0-9_-]{43}$", host);
        Assert.NotEqual(host, controller);
        Assert.Equal(new RelayTicket("session-1", RelaySide.Host), tickets.Redeem(host, "session-1"));
        Assert.Equal(new RelayTicket("session-1", RelaySide.Controller), tickets.Redeem(controller, "session-1"));
    }

    [Fact]
    public void A_ticket_works_once()
    {
        var tickets = new RemoteRelayTickets(_time);
        var ticket = tickets.Issue("session-1", RelaySide.Host);

        Assert.NotNull(tickets.Redeem(ticket, "session-1"));
        Assert.Null(tickets.Redeem(ticket, "session-1"));
    }

    [Fact]
    public void A_ticket_works_only_for_its_own_session()
    {
        var tickets = new RemoteRelayTickets(_time);
        var ticket = tickets.Issue("session-1", RelaySide.Host);

        Assert.Null(tickets.Redeem(ticket, "session-2"));
        Assert.Null(tickets.Redeem(ticket, "session-1"));
    }

    [Fact]
    public void A_ticket_runs_out_after_a_minute()
    {
        var tickets = new RemoteRelayTickets(_time);
        var ticket = tickets.Issue("session-1", RelaySide.Host);

        _time.Advance(TimeSpan.FromSeconds(61));

        Assert.Null(tickets.Redeem(ticket, "session-1"));
    }

    [Fact]
    public void A_made_up_ticket_is_refused()
    {
        var tickets = new RemoteRelayTickets(_time);

        Assert.Null(tickets.Redeem("made-up", "session-1"));
        Assert.Null(tickets.Redeem("", "session-1"));
    }

    [Fact]
    public void Old_tickets_do_not_pile_up()
    {
        var tickets = new RemoteRelayTickets(_time);
        for (var i = 0; i < 100; i++)
        {
            tickets.Issue($"s{i}", RelaySide.Host);
        }

        _time.Advance(TimeSpan.FromMinutes(2));
        tickets.Issue("fresh", RelaySide.Host);

        Assert.Equal(1, tickets.Count);
    }
}
