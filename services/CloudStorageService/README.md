# CloudStorageService

Go HTTP service that stores authenticated users' files in one Google Drive account.

The existing C# Auth service issues JWTs. This service validates those JWTs with the same HMAC key, issuer, and audience, then writes files to Google Drive using your Google account OAuth refresh token.

## Environment

Copy `.env.example` to `.env`, then fill in the values:

```powershell
Copy-Item .env.example .env
notepad .env
```

```bash
PORT=8082
JWT_KEY=the_same_value_as_AuthService_Jwt__Key
JWT_ISSUER=AuthService
JWT_AUDIENCE=AllServices

GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_REFRESH_TOKEN=your_refresh_token
DRIVE_ROOT_FOLDER_ID=optional_drive_folder_id
PREMIUM_USER_IDS=optional_comma_separated_jwt_user_ids
PREMIUM_USER_EMAILS=optional_comma_separated_emails
```

The service also accepts .NET-style names: `Jwt__Key`, `Jwt__Issuer`, `Jwt__Audience`, `Google__ClientId`, `Google__ClientSecret`, `Google__RefreshToken`, `Google__DriveRootFolderId`, `Premium__UserIds`, and `Premium__UserEmails`.

Free users get 100 MB. Users listed in `PREMIUM_USER_IDS` or `PREMIUM_USER_EMAILS` get 200 MB. This is a no-database bridge until a payment gateway stores subscription state.

The service loads `.env` automatically on startup. `.env.example` is only a sample file.

For your personal free Drive storage, use an OAuth client with the Drive API enabled and consent as your own Google account. A service account has separate storage, so it is usually the wrong choice unless you explicitly share a folder with it.

Required Google OAuth scope:

```text
https://www.googleapis.com/auth/drive.file
```

## API

All `/files` and `/storage` routes require:

```text
Authorization: Bearer <jwt-from-auth-service>
```

Routes:

- `GET /` health check
- `GET /storage` per-user plan and storage quota
- `POST /files` multipart upload with field name `file`
- `GET /files` list files owned by the current JWT user
- `GET /files/{id}` download one owned file
- `DELETE /files/{id}` delete one owned file

Files are tagged in Google Drive `appProperties` with the JWT user id, so users only see their own files through this API.

## Run

```bash
go mod tidy
go run .
```

Upload example:

```bash
curl -H "Authorization: Bearer $TOKEN" -F "file=@photo.png" http://localhost:8082/files
```
