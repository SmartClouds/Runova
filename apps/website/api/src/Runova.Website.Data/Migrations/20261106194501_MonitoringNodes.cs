using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class MonitoringNodes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MonitoringNodes",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Region = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Capacity = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Draining = table.Column<bool>(type: "boolean", nullable: false),
                    EnrollmentTokenHash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: true),
                    EnrollmentTokenExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    AllowedAddresses = table.Column<string[]>(type: "text[]", nullable: false),
                    EnrolledAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    SoftwareVersion = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    GatewayId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    RemoteAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    ConnectedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    Monitors = table.Column<int>(type: "integer", nullable: false),
                    ChecksLastMinute = table.Column<int>(type: "integer", nullable: false),
                    QueuedResults = table.Column<int>(type: "integer", nullable: false),
                    LagMs = table.Column<int>(type: "integer", nullable: false),
                    AssignmentVersion = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CreatedBy = table.Column<long>(type: "bigint", nullable: true),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MonitoringNodes", x => x.Id);
                    table.CheckConstraint("CK_MonitoringNodes_Status", "\"Status\" IN ('pending', 'online', 'offline', 'revoked')");
                });

            migrationBuilder.CreateTable(
                name: "NodeAuthorities",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false),
                    Certificate = table.Column<byte[]>(type: "bytea", nullable: false),
                    SealedPrivateKey = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NodeAuthorities", x => x.Id);
                    table.CheckConstraint("CK_NodeAuthority_Singleton", "\"Id\" = 1");
                });

            migrationBuilder.CreateTable(
                name: "NodeCertificates",
                columns: table => new
                {
                    Serial = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    NodeId = table.Column<long>(type: "bigint", nullable: false),
                    PublicKeyHash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: false),
                    NotBefore = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    NotAfter = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NodeCertificates", x => x.Serial);
                    table.ForeignKey(
                        name: "FK_NodeCertificates_MonitoringNodes_NodeId",
                        column: x => x.NodeId,
                        principalTable: "MonitoringNodes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MonitoringNodes_EnrollmentTokenHash",
                table: "MonitoringNodes",
                column: "EnrollmentTokenHash",
                unique: true,
                filter: "\"EnrollmentTokenHash\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_MonitoringNodes_Name",
                table: "MonitoringNodes",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MonitoringNodes_Status",
                table: "MonitoringNodes",
                column: "Status");

            migrationBuilder.CreateIndex(
                name: "IX_NodeCertificates_NodeId",
                table: "NodeCertificates",
                column: "NodeId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "NodeAuthorities");

            migrationBuilder.DropTable(
                name: "NodeCertificates");

            migrationBuilder.DropTable(
                name: "MonitoringNodes");
        }
    }
}
