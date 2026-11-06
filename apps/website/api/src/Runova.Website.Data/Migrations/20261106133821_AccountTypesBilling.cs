using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class AccountTypesBilling : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AccountTypes",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:IdentitySequenceOptions", "'100', '1', '', '', 'False', '1'")
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Key = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Features = table.Column<string[]>(type: "text[]", nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    IsFree = table.Column<bool>(type: "boolean", nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    Highlight = table.Column<bool>(type: "boolean", nullable: false),
                    MaxCloudMonitors = table.Column<int>(type: "integer", nullable: true),
                    MinIntervalSec = table.Column<int>(type: "integer", nullable: false),
                    HistoryDays = table.Column<int>(type: "integer", nullable: false),
                    MonthlyPriceCents = table.Column<int>(type: "integer", nullable: true),
                    YearlyPriceCents = table.Column<int>(type: "integer", nullable: true),
                    Currency = table.Column<string>(type: "character varying(3)", maxLength: 3, nullable: false),
                    StripeProductId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    StripeMonthlyPriceId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    StripeMonthlyPriceCents = table.Column<int>(type: "integer", nullable: true),
                    StripeYearlyPriceId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    StripeYearlyPriceCents = table.Column<int>(type: "integer", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AccountTypes", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BillingCustomers",
                columns: table => new
                {
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    StripeCustomerId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BillingCustomers", x => x.UserId);
                    table.ForeignKey(
                        name: "FK_BillingCustomers_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "PaymentSettings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false),
                    StripeEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    StripePublishableKey = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    StripeSecretKeySealed = table.Column<string>(type: "text", nullable: true),
                    StripeWebhookSecretSealed = table.Column<string>(type: "text", nullable: true),
                    NowPaymentsEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    NowPaymentsApiKeySealed = table.Column<string>(type: "text", nullable: true),
                    NowPaymentsIpnSecretSealed = table.Column<string>(type: "text", nullable: true),
                    NowPaymentsSandbox = table.Column<bool>(type: "boolean", nullable: false),
                    CryptoMonths = table.Column<int[]>(type: "integer[]", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PaymentSettings", x => x.Id);
                    table.CheckConstraint("CK_PaymentSettings_Singleton", "\"Id\" = 1");
                });

            migrationBuilder.CreateTable(
                name: "ProcessedPaymentEvents",
                columns: table => new
                {
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    EventId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    At = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProcessedPaymentEvents", x => new { x.Provider, x.EventId });
                });

            migrationBuilder.CreateTable(
                name: "Payments",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    OrderId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ProviderPaymentId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    AccountTypeId = table.Column<long>(type: "bigint", nullable: false),
                    Months = table.Column<int>(type: "integer", nullable: true),
                    AmountCents = table.Column<long>(type: "bigint", nullable: false),
                    Currency = table.Column<string>(type: "character varying(3)", maxLength: 3, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ProviderStatus = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    InvoiceUrl = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    PaidAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Payments", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Payments_AccountTypes_AccountTypeId",
                        column: x => x.AccountTypeId,
                        principalTable: "AccountTypes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Payments_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Subscriptions",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    AccountTypeId = table.Column<long>(type: "bigint", nullable: false),
                    Provider = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ProviderRef = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    StartedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CurrentPeriodEnd = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CancelAtPeriodEnd = table.Column<bool>(type: "boolean", nullable: false),
                    EndedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RemindedWeekAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RemindedDayAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    GrantedBy = table.Column<long>(type: "bigint", nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Subscriptions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Subscriptions_AccountTypes_AccountTypeId",
                        column: x => x.AccountTypeId,
                        principalTable: "AccountTypes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Subscriptions_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "AccountTypes",
                columns: new[] { "Id", "CreatedAt", "Currency", "Description", "Features", "Highlight", "HistoryDays", "IsActive", "IsFree", "Key", "MaxCloudMonitors", "MinIntervalSec", "MonthlyPriceCents", "Name", "SortOrder", "StripeMonthlyPriceCents", "StripeMonthlyPriceId", "StripeProductId", "StripeYearlyPriceCents", "StripeYearlyPriceId", "UpdatedAt", "YearlyPriceCents" },
                values: new object[,]
                {
                    { 1L, new DateTimeOffset(new DateTime(2026, 11, 6, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), "usd", "Try online monitoring on one endpoint.", new[] { "1 online monitor", "Checks every 5 minutes", "7 days of detailed history", "Alerts in the app and on Telegram" }, false, 7, true, true, "free", 1, 300, null, "Free", 0, null, null, null, null, null, null, null },
                    { 2L, new DateTimeOffset(new DateTime(2026, 11, 6, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), "usd", "For a few projects that should never go quiet.", new[] { "10 online monitors", "Checks every 5 minutes", "30 days of detailed history", "Alerts in the app and on Telegram" }, false, 30, true, false, "go", 10, 300, 500, "Go", 1, null, null, null, null, null, null, 5000 },
                    { 3L, new DateTimeOffset(new DateTime(2026, 11, 6, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), "usd", "Every project you run, checked every minute.", new[] { "50 online monitors", "Checks every minute", "90 days of detailed history", "Second opinion from another region" }, true, 90, true, false, "pro", 50, 60, 1500, "Pro", 2, null, null, null, null, null, null, 15000 },
                    { 4L, new DateTimeOffset(new DateTime(2026, 11, 6, 0, 0, 0, 0, DateTimeKind.Unspecified), new TimeSpan(0, 0, 0, 0, 0)), "usd", "No limits, and the fastest checks Runova makes.", new[] { "Unlimited online monitors", "Checks every 30 seconds", "A year of detailed history", "Second opinion from another region" }, false, 365, true, false, "ultra", null, 30, 4900, "Ultra", 3, null, null, null, null, null, null, 49000 }
                });

            migrationBuilder.InsertData(
                table: "PaymentSettings",
                columns: new[] { "Id", "CryptoMonths", "NowPaymentsApiKeySealed", "NowPaymentsEnabled", "NowPaymentsIpnSecretSealed", "NowPaymentsSandbox", "StripeEnabled", "StripePublishableKey", "StripeSecretKeySealed", "StripeWebhookSecretSealed", "UpdatedAt" },
                values: new object[] { 1, new[] { 1, 3, 12 }, null, false, null, false, false, null, null, null, null });

            migrationBuilder.CreateIndex(
                name: "IX_AccountTypes_IsFree",
                table: "AccountTypes",
                column: "IsFree",
                unique: true,
                filter: "\"IsFree\"");

            migrationBuilder.CreateIndex(
                name: "IX_AccountTypes_Key",
                table: "AccountTypes",
                column: "Key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_BillingCustomers_StripeCustomerId",
                table: "BillingCustomers",
                column: "StripeCustomerId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Payments_AccountTypeId",
                table: "Payments",
                column: "AccountTypeId");

            migrationBuilder.CreateIndex(
                name: "IX_Payments_OrderId",
                table: "Payments",
                column: "OrderId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Payments_Provider_ProviderPaymentId",
                table: "Payments",
                columns: new[] { "Provider", "ProviderPaymentId" },
                unique: true,
                filter: "\"ProviderPaymentId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Payments_UserId_CreatedAt",
                table: "Payments",
                columns: new[] { "UserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_Subscriptions_AccountTypeId",
                table: "Subscriptions",
                column: "AccountTypeId");

            migrationBuilder.CreateIndex(
                name: "IX_Subscriptions_Provider_ProviderRef",
                table: "Subscriptions",
                columns: new[] { "Provider", "ProviderRef" },
                unique: true,
                filter: "\"ProviderRef\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Subscriptions_Status_CurrentPeriodEnd",
                table: "Subscriptions",
                columns: new[] { "Status", "CurrentPeriodEnd" });

            migrationBuilder.CreateIndex(
                name: "IX_Subscriptions_UserId",
                table: "Subscriptions",
                column: "UserId",
                unique: true,
                filter: "\"Status\" IN ('active', 'past_due')");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "BillingCustomers");

            migrationBuilder.DropTable(
                name: "PaymentSettings");

            migrationBuilder.DropTable(
                name: "Payments");

            migrationBuilder.DropTable(
                name: "ProcessedPaymentEvents");

            migrationBuilder.DropTable(
                name: "Subscriptions");

            migrationBuilder.DropTable(
                name: "AccountTypes");
        }
    }
}
