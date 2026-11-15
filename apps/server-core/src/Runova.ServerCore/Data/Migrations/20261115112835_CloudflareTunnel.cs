using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class CloudflareTunnel : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CloudflareTunnel",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    TunnelId = table.Column<Guid>(type: "TEXT", nullable: true),
                    TunnelName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    AccountTag = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    SshHostname = table.Column<string>(type: "TEXT", maxLength: 253, nullable: true),
                    ProtectedToken = table.Column<string>(type: "TEXT", maxLength: 16384, nullable: true),
                    SshMode = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    TunnelPort = table.Column<int>(type: "INTEGER", nullable: false),
                    MetricsPort = table.Column<int>(type: "INTEGER", nullable: false),
                    BreakGlassEnabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    BreakGlassDelayMinutes = table.Column<int>(type: "INTEGER", nullable: false),
                    BreakGlassOpen = table.Column<bool>(type: "INTEGER", nullable: false),
                    SetupJobId = table.Column<Guid>(type: "TEXT", nullable: true),
                    ChangeSetId = table.Column<Guid>(type: "TEXT", nullable: true),
                    ChangeKind = table.Column<string>(type: "TEXT", maxLength: 10, nullable: true),
                    PendingSshMode = table.Column<string>(type: "TEXT", maxLength: 20, nullable: true),
                    OffForOriginLock = table.Column<bool>(type: "INTEGER", nullable: false),
                    WebClosed = table.Column<bool>(type: "INTEGER", nullable: false),
                    MeshAddress = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    LastError = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    LastConnectedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    DownSince = table.Column<long>(type: "INTEGER", nullable: true),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CloudflareTunnel", x => x.Id);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CloudflareTunnel");
        }
    }
}
