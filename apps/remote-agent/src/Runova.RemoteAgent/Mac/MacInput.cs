using System.Text.Json.Nodes;

namespace Runova.RemoteAgent.Mac;

/// <summary>One Core Graphics input step for a controller event.</summary>
public abstract record MacStep
{
    /// <param name="Type">The CGEventType.</param>
    /// <param name="X">Across the display, in points.</param>
    /// <param name="Y">Down the display, in points.</param>
    /// <param name="Button">The CGMouseButton: 0 left, 1 right, 2 middle.</param>
    public sealed record Mouse(int Type, double X, double Y, int Button) : MacStep;

    public sealed record Key(ushort VirtualKey, bool Down) : MacStep;

    public sealed record Scroll(int Vertical, int Horizontal) : MacStep;

    public sealed record Text(string Value) : MacStep;
}

/// <summary>Which mouse button is down, since macOS has separate events for dragging.</summary>
public sealed class MacButtons
{
    internal int? Held { get; set; }
}

/// <summary>
/// The app's `RemoteInputEvent` as Core Graphics steps (E65), the same mapping as the desktop's
/// macOS helper (apps/desktop/src/main/remote/input/backends.ts).
/// </summary>
public static class MacInput
{
    private const int MouseMoved = 5;

    private static readonly int[] _downTypes = [1, 3, 25];
    private static readonly int[] _upTypes = [2, 4, 26];
    private static readonly int[] _dragTypes = [6, 7, 27];

    private static readonly Dictionary<string, ushort> _virtualKeys = new(StringComparer.Ordinal)
    {
        ["Enter"] = 36,
        ["NumpadEnter"] = 76,
        ["Tab"] = 48,
        ["Backspace"] = 51,
        ["Delete"] = 117,
        ["Escape"] = 53,
        ["ArrowLeft"] = 123,
        ["ArrowRight"] = 124,
        ["ArrowDown"] = 125,
        ["ArrowUp"] = 126,
        ["Home"] = 115,
        ["End"] = 119,
        ["PageUp"] = 116,
        ["PageDown"] = 121,
        ["ShiftLeft"] = 56,
        ["ShiftRight"] = 60,
        ["ControlLeft"] = 59,
        ["ControlRight"] = 62,
        ["AltLeft"] = 58,
        ["AltRight"] = 61,
        ["MetaLeft"] = 55,
        ["MetaRight"] = 54,
        ["CapsLock"] = 57,
        ["F1"] = 122,
        ["F2"] = 120,
        ["F3"] = 99,
        ["F4"] = 118,
        ["F5"] = 96,
        ["F6"] = 97,
        ["F7"] = 98,
        ["F8"] = 100,
        ["F9"] = 101,
        ["F10"] = 109,
        ["F11"] = 103,
        ["F12"] = 111,
    };

    public static IReadOnlyList<MacStep> Steps(JsonObject inputEvent, double displayWidth, double displayHeight, MacButtons held)
    {
        ArgumentNullException.ThrowIfNull(inputEvent);
        ArgumentNullException.ThrowIfNull(held);
        double At(string axis, double size) => Math.Clamp(((double?)inputEvent[axis] ?? 0) * size, 0, size - 1);
        var x = At("x", displayWidth);
        var y = At("y", displayHeight);
        switch ((string?)inputEvent["k"])
        {
            case "move":
                return held.Held is { } dragging
                    ? [new MacStep.Mouse(_dragTypes[dragging], x, y, dragging)]
                    : [new MacStep.Mouse(MouseMoved, x, y, 0)];
            case "down":
                {
                    var button = ButtonOf(inputEvent);
                    held.Held = button;
                    return [new MacStep.Mouse(_downTypes[button], x, y, button)];
                }

            case "up":
                {
                    var button = ButtonOf(inputEvent);
                    held.Held = null;
                    return [new MacStep.Mouse(_upTypes[button], x, y, button)];
                }

            case "wheel":
                return [new MacStep.Scroll(-(int)Math.Round((double?)inputEvent["dy"] ?? 0), -(int)Math.Round((double?)inputEvent["dx"] ?? 0))];
            case "key":
                return _virtualKeys.TryGetValue((string?)inputEvent["code"] ?? "", out var key)
                    ? [new MacStep.Key(key, (bool?)inputEvent["down"] ?? false)]
                    : [];
            case "text":
                return [new MacStep.Text((string?)inputEvent["text"] ?? "")];
            default:
                return [];
        }
    }

    private static int ButtonOf(JsonObject inputEvent) => (string?)inputEvent["button"] switch
    {
        "right" => 1,
        "middle" => 2,
        _ => 0,
    };
}
