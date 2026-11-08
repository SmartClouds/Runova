using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class RemoteDevices : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "RemoteDevices",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    RemoteId = table.Column<string>(type: "character varying(9)", maxLength: 9, nullable: false),
                    DeviceId = table.Column<Guid>(type: "uuid", nullable: false),
                    Kind = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Platform = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    IdentityKey = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    AllowOwnDevices = table.Column<bool>(type: "boolean", nullable: false),
                    UnattendedEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    AgentIdentityKey = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    AgentSecretHash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: true),
                    AgentEnabledAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RemoteDevices", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RemoteDevices_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "RemoteDeviceTeams",
                columns: table => new
                {
                    RemoteDeviceId = table.Column<long>(type: "bigint", nullable: false),
                    TeamId = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RemoteDeviceTeams", x => new { x.RemoteDeviceId, x.TeamId });
                    table.ForeignKey(
                        name: "FK_RemoteDeviceTeams_RemoteDevices_RemoteDeviceId",
                        column: x => x.RemoteDeviceId,
                        principalTable: "RemoteDevices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_RemoteDeviceTeams_Teams_TeamId",
                        column: x => x.TeamId,
                        principalTable: "Teams",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "RemoteSessionRecords",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    HostDeviceId = table.Column<long>(type: "bigint", nullable: false),
                    HostUserId = table.Column<long>(type: "bigint", nullable: false),
                    ControllerUserId = table.Column<long>(type: "bigint", nullable: false),
                    ControllerDeviceId = table.Column<long>(type: "bigint", nullable: true),
                    Mode = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Transport = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    StartedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    EndedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RemoteSessionRecords", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RemoteSessionRecords_AspNetUsers_ControllerUserId",
                        column: x => x.ControllerUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_RemoteSessionRecords_AspNetUsers_HostUserId",
                        column: x => x.HostUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_RemoteSessionRecords_RemoteDevices_HostDeviceId",
                        column: x => x.HostDeviceId,
                        principalTable: "RemoteDevices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_RemoteDeviceTeams_TeamId",
                table: "RemoteDeviceTeams",
                column: "TeamId");

            migrationBuilder.CreateIndex(
                name: "IX_RemoteDevices_RemoteId",
                table: "RemoteDevices",
                column: "RemoteId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RemoteDevices_UserId_DeviceId_Kind",
                table: "RemoteDevices",
                columns: new[] { "UserId", "DeviceId", "Kind" },
                unique: true,
                filter: "\"RevokedAt\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_RemoteSessionRecords_ControllerUserId_StartedAt",
                table: "RemoteSessionRecords",
                columns: new[] { "ControllerUserId", "StartedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_RemoteSessionRecords_HostDeviceId",
                table: "RemoteSessionRecords",
                column: "HostDeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_RemoteSessionRecords_HostUserId_StartedAt",
                table: "RemoteSessionRecords",
                columns: new[] { "HostUserId", "StartedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_RemoteSessionRecords_StartedAt",
                table: "RemoteSessionRecords",
                column: "StartedAt");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "RemoteDeviceTeams");

            migrationBuilder.DropTable(
                name: "RemoteSessionRecords");

            migrationBuilder.DropTable(
                name: "RemoteDevices");
        }
    }
}
