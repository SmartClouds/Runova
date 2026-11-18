using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Traffic;

/// <summary>
/// The access log format every site writes (E109): nginx's own <c>combined</c> fields, so the lines
/// stay readable in the Logs tab and old lines still parse, then what statistics and detection read.
/// <see cref="AccessLogParser"/> reads the fields in exactly this order.
/// </summary>
internal static class TrafficLogFormat
{
    /// <summary>nginx's combined format, field for field.</summary>
    public const string Combined =
        "$remote_addr - $remote_user [$time_local] \"$request\" $status $body_bytes_sent \"$http_referer\" \"$http_user_agent\"";

    /// <summary>
    /// The host asked for, the request time in seconds, the response's content type, the scheme, the
    /// address that connected (before the real-IP modules replaced it) and Cloudflare's location headers.
    /// </summary>
    public const string Extra =
        "\"$host\" $request_time \"$sent_http_content_type\" $scheme $realip_remote_addr \"$http_cf_ipcountry\" \"$http_cf_ipcity\" \"$http_cf_region\"";

    public static string Name(NginxLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return layout.NamePrefix + "_main";
    }
}
