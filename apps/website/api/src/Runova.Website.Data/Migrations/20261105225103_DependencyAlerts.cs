using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class DependencyAlerts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AdvisoryLookups",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Ecosystem = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Name = table.Column<string>(type: "character varying(214)", maxLength: 214, nullable: false),
                    Version = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Advisories = table.Column<string>(type: "jsonb", nullable: false),
                    CheckedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AdvisoryLookups", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "DependencyAlertDeliveries",
                columns: table => new
                {
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    Key = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    At = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DependencyAlertDeliveries", x => new { x.UserId, x.Key });
                    table.ForeignKey(
                        name: "FK_DependencyAlertDeliveries_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DependencyAlertSettings",
                columns: table => new
                {
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    SecurityMinSeverity = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Deprecated = table.Column<bool>(type: "boolean", nullable: false),
                    Major = table.Column<bool>(type: "boolean", nullable: false),
                    Minor = table.Column<bool>(type: "boolean", nullable: false),
                    Patch = table.Column<bool>(type: "boolean", nullable: false),
                    InApp = table.Column<bool>(type: "boolean", nullable: false),
                    Telegram = table.Column<bool>(type: "boolean", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DependencyAlertSettings", x => x.UserId);
                    table.ForeignKey(
                        name: "FK_DependencyAlertSettings_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "PackageFacts",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Ecosystem = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Name = table.Column<string>(type: "character varying(214)", maxLength: 214, nullable: false),
                    Found = table.Column<bool>(type: "boolean", nullable: false),
                    LatestVersion = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    Deprecated = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CheckedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PackageFacts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "PackageInventories",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ScopeId = table.Column<long>(type: "bigint", nullable: false),
                    ItemId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ProjectName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    UploadedBy = table.Column<long>(type: "bigint", nullable: true),
                    UploadedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ContentHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    NextCheckAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    LastCheckedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PackageInventories", x => x.Id);
                    table.ForeignKey(
                        name: "FK_PackageInventories_SyncScopes_ScopeId",
                        column: x => x.ScopeId,
                        principalTable: "SyncScopes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "TelegramLinkCodes",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    CodeHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TelegramLinkCodes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TelegramLinkCodes_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "TelegramLinks",
                columns: table => new
                {
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    ChatId = table.Column<long>(type: "bigint", nullable: false),
                    ChatName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    LinkedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TelegramLinks", x => x.UserId);
                    table.ForeignKey(
                        name: "FK_TelegramLinks_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "TelegramMessages",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ChatId = table.Column<long>(type: "bigint", nullable: false),
                    Text = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    NextAttemptAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    SentAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    LastError = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TelegramMessages", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "UserNotifications",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    Kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    Body = table.Column<string>(type: "text", nullable: false),
                    Severity = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    ScopeId = table.Column<long>(type: "bigint", nullable: true),
                    ItemId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    InventoryId = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ReadAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserNotifications", x => x.Id);
                    table.ForeignKey(
                        name: "FK_UserNotifications_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DependencyFindings",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    InventoryId = table.Column<long>(type: "bigint", nullable: false),
                    Ecosystem = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Name = table.Column<string>(type: "character varying(214)", maxLength: 214, nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    CurrentVersion = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    TargetVersion = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    AdvisoryId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Severity = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    Summary = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Key = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    FirstSeenAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DependencyFindings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DependencyFindings_PackageInventories_InventoryId",
                        column: x => x.InventoryId,
                        principalTable: "PackageInventories",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "InventoryPackages",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    InventoryId = table.Column<long>(type: "bigint", nullable: false),
                    Ecosystem = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Name = table.Column<string>(type: "character varying(214)", maxLength: 214, nullable: false),
                    Version = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Dev = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InventoryPackages", x => x.Id);
                    table.ForeignKey(
                        name: "FK_InventoryPackages_PackageInventories_InventoryId",
                        column: x => x.InventoryId,
                        principalTable: "PackageInventories",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "MutedProjects",
                columns: table => new
                {
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    InventoryId = table.Column<long>(type: "bigint", nullable: false),
                    MutedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MutedProjects", x => new { x.UserId, x.InventoryId });
                    table.ForeignKey(
                        name: "FK_MutedProjects_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_MutedProjects_PackageInventories_InventoryId",
                        column: x => x.InventoryId,
                        principalTable: "PackageInventories",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AdvisoryLookups_Ecosystem_Name_Version",
                table: "AdvisoryLookups",
                columns: new[] { "Ecosystem", "Name", "Version" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DependencyFindings_InventoryId_Key",
                table: "DependencyFindings",
                columns: new[] { "InventoryId", "Key" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_InventoryPackages_InventoryId",
                table: "InventoryPackages",
                column: "InventoryId");

            migrationBuilder.CreateIndex(
                name: "IX_MutedProjects_InventoryId",
                table: "MutedProjects",
                column: "InventoryId");

            migrationBuilder.CreateIndex(
                name: "IX_PackageFacts_Ecosystem_Name",
                table: "PackageFacts",
                columns: new[] { "Ecosystem", "Name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_PackageInventories_NextCheckAt",
                table: "PackageInventories",
                column: "NextCheckAt");

            migrationBuilder.CreateIndex(
                name: "IX_PackageInventories_ScopeId_ItemId",
                table: "PackageInventories",
                columns: new[] { "ScopeId", "ItemId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TelegramLinkCodes_CodeHash",
                table: "TelegramLinkCodes",
                column: "CodeHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TelegramLinkCodes_ExpiresAt",
                table: "TelegramLinkCodes",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_TelegramLinkCodes_UserId",
                table: "TelegramLinkCodes",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_TelegramLinks_ChatId",
                table: "TelegramLinks",
                column: "ChatId");

            migrationBuilder.CreateIndex(
                name: "IX_TelegramMessages_SentAt_NextAttemptAt",
                table: "TelegramMessages",
                columns: new[] { "SentAt", "NextAttemptAt" });

            migrationBuilder.CreateIndex(
                name: "IX_UserNotifications_UserId_CreatedAt",
                table: "UserNotifications",
                columns: new[] { "UserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_UserNotifications_UserId_ReadAt",
                table: "UserNotifications",
                columns: new[] { "UserId", "ReadAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AdvisoryLookups");

            migrationBuilder.DropTable(
                name: "DependencyAlertDeliveries");

            migrationBuilder.DropTable(
                name: "DependencyAlertSettings");

            migrationBuilder.DropTable(
                name: "DependencyFindings");

            migrationBuilder.DropTable(
                name: "InventoryPackages");

            migrationBuilder.DropTable(
                name: "MutedProjects");

            migrationBuilder.DropTable(
                name: "PackageFacts");

            migrationBuilder.DropTable(
                name: "TelegramLinkCodes");

            migrationBuilder.DropTable(
                name: "TelegramLinks");

            migrationBuilder.DropTable(
                name: "TelegramMessages");

            migrationBuilder.DropTable(
                name: "UserNotifications");

            migrationBuilder.DropTable(
                name: "PackageInventories");
        }
    }
}
