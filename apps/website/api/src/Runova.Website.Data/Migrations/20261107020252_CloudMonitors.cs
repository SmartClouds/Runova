using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class CloudMonitors : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CloudMonitors",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ScopeId = table.Column<long>(type: "bigint", nullable: false),
                    ItemId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    ProjectName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    EnvironmentName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Url = table.Column<string>(type: "character varying(2048)", maxLength: 2048, nullable: false),
                    IntervalSec = table.Column<int>(type: "integer", nullable: false),
                    TimeoutSec = table.Column<int>(type: "integer", nullable: false),
                    AuthMode = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    SealedSecret = table.Column<string>(type: "text", nullable: true),
                    SecretChangedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    AllowInsecure = table.Column<bool>(type: "boolean", nullable: false),
                    Paused = table.Column<bool>(type: "boolean", nullable: false),
                    SuspendedReason = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    NotifyInApp = table.Column<bool>(type: "boolean", nullable: false),
                    NotifyTelegram = table.Column<bool>(type: "boolean", nullable: false),
                    DefinitionVersion = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<long>(type: "bigint", nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CloudMonitors", x => x.Id);
                    table.CheckConstraint("CK_CloudMonitors_AuthMode", "\"AuthMode\" IN ('none', 'bearer', 'basic')");
                    table.CheckConstraint("CK_CloudMonitors_Interval", "\"IntervalSec\" > 0 AND \"TimeoutSec\" > 0");
                    table.ForeignKey(
                        name: "FK_CloudMonitors_SyncScopes_ScopeId",
                        column: x => x.ScopeId,
                        principalTable: "SyncScopes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "CloudMonitorHours",
                columns: table => new
                {
                    MonitorId = table.Column<long>(type: "bigint", nullable: false),
                    Hour = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Checks = table.Column<int>(type: "integer", nullable: false),
                    Failures = table.Column<int>(type: "integer", nullable: false),
                    Warnings = table.Column<int>(type: "integer", nullable: false),
                    LatencySumMs = table.Column<long>(type: "bigint", nullable: false),
                    LatencyCount = table.Column<int>(type: "integer", nullable: false),
                    LatencyMaxMs = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CloudMonitorHours", x => new { x.MonitorId, x.Hour });
                    table.ForeignKey(
                        name: "FK_CloudMonitorHours_CloudMonitors_MonitorId",
                        column: x => x.MonitorId,
                        principalTable: "CloudMonitors",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "CloudMonitorIncidents",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    MonitorId = table.Column<long>(type: "bigint", nullable: false),
                    OpenedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ResolvedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Problem = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    NodeId = table.Column<long>(type: "bigint", nullable: true),
                    ConfirmedByNodeId = table.Column<long>(type: "bigint", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CloudMonitorIncidents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CloudMonitorIncidents_CloudMonitors_MonitorId",
                        column: x => x.MonitorId,
                        principalTable: "CloudMonitors",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "CloudMonitorMutes",
                columns: table => new
                {
                    MonitorId = table.Column<long>(type: "bigint", nullable: false),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    At = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CloudMonitorMutes", x => new { x.MonitorId, x.UserId });
                    table.ForeignKey(
                        name: "FK_CloudMonitorMutes_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_CloudMonitorMutes_CloudMonitors_MonitorId",
                        column: x => x.MonitorId,
                        principalTable: "CloudMonitors",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "CloudMonitorSamples",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    MonitorId = table.Column<long>(type: "bigint", nullable: false),
                    CheckedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    LatencyMs = table.Column<int>(type: "integer", nullable: true),
                    HttpStatus = table.Column<int>(type: "integer", nullable: true),
                    NodeId = table.Column<long>(type: "bigint", nullable: true),
                    Problem = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Confirm = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CloudMonitorSamples", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CloudMonitorSamples_CloudMonitors_MonitorId",
                        column: x => x.MonitorId,
                        principalTable: "CloudMonitors",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "CloudMonitorStatuses",
                columns: table => new
                {
                    MonitorId = table.Column<long>(type: "bigint", nullable: false),
                    NodeId = table.Column<long>(type: "bigint", nullable: true),
                    State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    Confirmed = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    Streak = table.Column<int>(type: "integer", nullable: false),
                    Pending = table.Column<bool>(type: "boolean", nullable: false),
                    LastCheckedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LatencyMs = table.Column<int>(type: "integer", nullable: true),
                    HttpStatus = table.Column<int>(type: "integer", nullable: true),
                    Problem = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    LastNodeId = table.Column<long>(type: "bigint", nullable: true),
                    LastRegion = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    ConfirmId = table.Column<Guid>(type: "uuid", nullable: true),
                    ConfirmNodeId = table.Column<long>(type: "bigint", nullable: true),
                    ConfirmRequestedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    SuspectSince = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    SuspectState = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    SuspectProblem = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    OpenIncidentId = table.Column<long>(type: "bigint", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CloudMonitorStatuses", x => x.MonitorId);
                    table.ForeignKey(
                        name: "FK_CloudMonitorStatuses_CloudMonitors_MonitorId",
                        column: x => x.MonitorId,
                        principalTable: "CloudMonitors",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_CloudMonitorStatuses_MonitoringNodes_NodeId",
                        column: x => x.NodeId,
                        principalTable: "MonitoringNodes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateIndex(
                name: "IX_CloudMonitorIncidents_MonitorId_OpenedAt",
                table: "CloudMonitorIncidents",
                columns: new[] { "MonitorId", "OpenedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_CloudMonitorMutes_UserId",
                table: "CloudMonitorMutes",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_CloudMonitorSamples_CheckedAt",
                table: "CloudMonitorSamples",
                column: "CheckedAt")
                .Annotation("Npgsql:IndexMethod", "brin");

            migrationBuilder.CreateIndex(
                name: "IX_CloudMonitorSamples_MonitorId_CheckedAt",
                table: "CloudMonitorSamples",
                columns: new[] { "MonitorId", "CheckedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_CloudMonitorStatuses_NodeId",
                table: "CloudMonitorStatuses",
                column: "NodeId");

            migrationBuilder.CreateIndex(
                name: "IX_CloudMonitors_ScopeId_ItemId",
                table: "CloudMonitors",
                columns: new[] { "ScopeId", "ItemId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "CloudMonitorHours");

            migrationBuilder.DropTable(
                name: "CloudMonitorIncidents");

            migrationBuilder.DropTable(
                name: "CloudMonitorMutes");

            migrationBuilder.DropTable(
                name: "CloudMonitorSamples");

            migrationBuilder.DropTable(
                name: "CloudMonitorStatuses");

            migrationBuilder.DropTable(
                name: "CloudMonitors");
        }
    }
}
