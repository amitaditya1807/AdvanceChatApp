using ChatService.Endpoints;
using ChatService.Repositories;
using ChatService.Repositories.Interfaces;
using ChatService.Services;
using ChatService.Services.Interfaces;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using System.Security.Claims;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

var port = Environment.GetEnvironmentVariable("PORT") ?? "10000";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

// 🌍 Load ENV
builder.Configuration.AddEnvironmentVariables();

// 🔐 JWT Config
var jwtKey = builder.Configuration["Jwt:Key"];
var jwtIssuer = builder.Configuration["Jwt:Issuer"];
var jwtAudience = builder.Configuration["Jwt:Audience"];

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer("Bearer", options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,

            ValidIssuer = jwtIssuer ?? "AuthService",
            ValidAudience = jwtAudience ?? "AllServices",
            IssuerSigningKey = new SymmetricSecurityKey(
                Encoding.UTF8.GetBytes(jwtKey!))
        };
    });

builder.Services.AddAuthorization();
builder.Services.AddSingleton<IChatRoomRepository, InMemoryChatRoomRepository>();
builder.Services.AddScoped<IChatRoomService, ChatRoomService>();

// 🌐 CORS (important for frontend)
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

var app = builder.Build();

app.UseCors();

app.UseAuthentication();
app.UseAuthorization();

// 🟢 Health check
app.MapGet("/", () => "Chat Service Running 🚀");

// 🔒 Protected route
app.MapGet("/chat", (HttpContext context) =>
{
    var userId = context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;

    return Results.Json(new
    {
        message = $"Hello {userId}, Chat service working!",
        time = DateTime.UtcNow
    });
})
.RequireAuthorization();

// 💬 Chat room routes
app.MapChatRoomEndpoints();

app.Run();
