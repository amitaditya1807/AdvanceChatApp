package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

const (
	maxUploadBytes            = 25 << 20
	freeUserStorageLimitBytes = 100 << 20
	premiumUserLimitBytes     = 200 << 20
	freeStoragePlanName       = "free"
	premiumStoragePlanName    = "premium"
)

type config struct {
	Addr               string
	JWTKey             string
	JWTIssuer          string
	JWTAudience        string
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRefreshToken string
	DriveRootFolderID  string
	PremiumUserIDs     map[string]struct{}
	PremiumUserEmails  map[string]struct{}
}

type server struct {
	cfg   config
	drive *drive.Service
}

type authUser struct {
	ID    string
	Email string
	Name  string
}

type driveFile struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	MimeType     string    `json:"mimeType"`
	Size         int64     `json:"size"`
	CreatedTime  time.Time `json:"createdTime"`
	ModifiedTime time.Time `json:"modifiedTime"`
}

func main() {
	if err := loadDotEnv(".env"); err != nil {
		log.Printf("warning: %v", err)
	}

	cfg := loadConfig()
	if err := cfg.validate(); err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	ctx := context.Background()
	driveSvc, err := newDriveService(ctx, cfg)
	if err != nil {
		log.Fatalf("google drive setup failed: %v", err)
	}

	s := &server{cfg: cfg, drive: driveSvc}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", s.health)
	mux.HandleFunc("GET /storage", s.withAuth(s.storageInfo))
	mux.HandleFunc("POST /files", s.withAuth(s.uploadFile))
	mux.HandleFunc("GET /files", s.withAuth(s.listFiles))
	mux.HandleFunc("GET /files/{id}", s.withAuth(s.downloadFile))
	mux.HandleFunc("DELETE /files/{id}", s.withAuth(s.deleteFile))

	handler := withCORS(mux)
	log.Printf("Cloud Storage Service running on %s", cfg.Addr)
	if err := http.ListenAndServe(cfg.Addr, handler); err != nil {
		log.Fatal(err)
	}
}

func loadConfig() config {
	port := getenv("PORT", "8082")
	return config{
		Addr:               ":" + port,
		JWTKey:             getenvAny([]string{"JWT_KEY", "Jwt__Key"}, ""),
		JWTIssuer:          getenvAny([]string{"JWT_ISSUER", "Jwt__Issuer"}, "AuthService"),
		JWTAudience:        getenvAny([]string{"JWT_AUDIENCE", "Jwt__Audience"}, "AllServices"),
		GoogleClientID:     getenvAny([]string{"GOOGLE_CLIENT_ID", "Google__ClientId"}, ""),
		GoogleClientSecret: getenvAny([]string{"GOOGLE_CLIENT_SECRET", "Google__ClientSecret"}, ""),
		GoogleRefreshToken: getenvAny([]string{"GOOGLE_REFRESH_TOKEN", "Google__RefreshToken"}, ""),
		DriveRootFolderID:  getenvAny([]string{"DRIVE_ROOT_FOLDER_ID", "Google__DriveRootFolderId"}, ""),
		PremiumUserIDs:     parseCSVSet(getenvAny([]string{"PREMIUM_USER_IDS", "Premium__UserIds"}, "")),
		PremiumUserEmails:  parseCSVSet(getenvAny([]string{"PREMIUM_USER_EMAILS", "Premium__UserEmails"}, "")),
	}
}

func (c config) validate() error {
	missing := make([]string, 0)
	for name, value := range map[string]string{
		"JWT_KEY":              c.JWTKey,
		"GOOGLE_CLIENT_ID":     c.GoogleClientID,
		"GOOGLE_CLIENT_SECRET": c.GoogleClientSecret,
		"GOOGLE_REFRESH_TOKEN": c.GoogleRefreshToken,
	} {
		if strings.TrimSpace(value) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required environment variables: %s", strings.Join(missing, ", "))
	}
	return nil
}

func newDriveService(ctx context.Context, cfg config) (*drive.Service, error) {
	oauthCfg := &oauth2.Config{
		ClientID:     cfg.GoogleClientID,
		ClientSecret: cfg.GoogleClientSecret,
		Endpoint:     google.Endpoint,
		Scopes:       []string{drive.DriveFileScope},
	}
	token := &oauth2.Token{RefreshToken: cfg.GoogleRefreshToken}
	client := oauthCfg.Client(ctx, token)
	return drive.NewService(ctx, option.WithHTTPClient(client))
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"message": "Cloud Storage Service Running"})
}

func (s *server) storageInfo(w http.ResponseWriter, r *http.Request, user authUser) {
	about, err := s.drive.About.Get().Fields("storageQuota").Context(r.Context()).Do()
	if err != nil {
		writeDriveError(w, err)
		return
	}

	userUsage, err := s.userStorageUsage(r.Context(), user)
	if err != nil {
		writeDriveError(w, err)
		return
	}
	planName, userLimit := s.userStoragePlan(user)
	userRemaining := userLimit - userUsage
	if userRemaining < 0 {
		userRemaining = 0
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"limit":         strconv.FormatInt(about.StorageQuota.Limit, 10),
		"usage":         strconv.FormatInt(about.StorageQuota.Usage, 10),
		"usageInDrive":  strconv.FormatInt(about.StorageQuota.UsageInDrive, 10),
		"plan":          planName,
		"userLimit":     strconv.FormatInt(userLimit, 10),
		"userUsage":     strconv.FormatInt(userUsage, 10),
		"userRemaining": strconv.FormatInt(userRemaining, 10),
	})
}

func (s *server) uploadFile(w http.ResponseWriter, r *http.Request, user authUser) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "file upload is invalid or too large")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "multipart form field 'file' is required")
		return
	}
	defer file.Close()

	currentUsage, err := s.userStorageUsage(r.Context(), user)
	if err != nil {
		writeDriveError(w, err)
		return
	}
	planName, userLimit := s.userStoragePlan(user)
	if currentUsage+header.Size > userLimit {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("%s storage limit exceeded: %s used, %s limit", planName, formatBytes(currentUsage), formatBytes(userLimit)))
		return
	}

	created, err := s.createDriveFile(r.Context(), user, header, file)
	if err != nil {
		writeDriveError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, mapDriveFile(created))
}

func (s *server) createDriveFile(ctx context.Context, user authUser, header *multipart.FileHeader, file multipart.File) (*drive.File, error) {
	meta := &drive.File{
		Name: header.Filename,
		AppProperties: map[string]string{
			"userId":       user.ID,
			"originalName": header.Filename,
		},
	}
	if s.cfg.DriveRootFolderID != "" {
		meta.Parents = []string{s.cfg.DriveRootFolderID}
	}

	call := s.drive.Files.Create(meta).Media(file, googleapi.ContentType(header.Header.Get("Content-Type")))
	return call.Fields("id,name,mimeType,size,createdTime,modifiedTime").Context(ctx).Do()
}

func (s *server) listFiles(w http.ResponseWriter, r *http.Request, user authUser) {
	resp, err := s.drive.Files.List().
		Q(s.userFilesQuery(user)).
		Fields("files(id,name,mimeType,size,createdTime,modifiedTime)").
		OrderBy("modifiedTime desc").
		PageSize(100).
		Context(r.Context()).
		Do()
	if err != nil {
		writeDriveError(w, err)
		return
	}

	files := make([]driveFile, 0, len(resp.Files))
	for _, file := range resp.Files {
		files = append(files, mapDriveFile(file))
	}

	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (s *server) downloadFile(w http.ResponseWriter, r *http.Request, user authUser) {
	fileID := r.PathValue("id")
	meta, err := s.getOwnedFile(r.Context(), fileID, user)
	if err != nil {
		writeDriveError(w, err)
		return
	}

	resp, err := s.drive.Files.Get(fileID).Download()
	if err != nil {
		writeDriveError(w, err)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", meta.MimeType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", meta.Name))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, resp.Body)
}

func (s *server) deleteFile(w http.ResponseWriter, r *http.Request, user authUser) {
	fileID := r.PathValue("id")
	if _, err := s.getOwnedFile(r.Context(), fileID, user); err != nil {
		writeDriveError(w, err)
		return
	}

	if err := s.drive.Files.Delete(fileID).Context(r.Context()).Do(); err != nil {
		writeDriveError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *server) getOwnedFile(ctx context.Context, fileID string, user authUser) (*drive.File, error) {
	file, err := s.drive.Files.Get(fileID).
		Fields("id,name,mimeType,size,createdTime,modifiedTime,appProperties").
		Context(ctx).
		Do()
	if err != nil {
		return nil, err
	}
	if file.AppProperties["userId"] != user.ID {
		return nil, &googleapi.Error{Code: http.StatusNotFound, Message: "file not found"}
	}
	return file, nil
}

func (s *server) userStorageUsage(ctx context.Context, user authUser) (int64, error) {
	var total int64
	pageToken := ""

	for {
		call := s.drive.Files.List().
			Q(s.userFilesQuery(user)).
			Fields("nextPageToken,files(size)").
			PageSize(1000).
			Context(ctx)
		if pageToken != "" {
			call.PageToken(pageToken)
		}

		resp, err := call.Do()
		if err != nil {
			return 0, err
		}
		for _, file := range resp.Files {
			total += file.Size
		}
		if resp.NextPageToken == "" {
			return total, nil
		}
		pageToken = resp.NextPageToken
	}
}

func (s *server) userFilesQuery(user authUser) string {
	queryParts := []string{
		"trashed = false",
		fmt.Sprintf("appProperties has { key='userId' and value='%s' }", escapeDriveQuery(user.ID)),
	}
	if s.cfg.DriveRootFolderID != "" {
		queryParts = append(queryParts, fmt.Sprintf("'%s' in parents", escapeDriveQuery(s.cfg.DriveRootFolderID)))
	}
	return strings.Join(queryParts, " and ")
}

func (s *server) userStoragePlan(user authUser) (string, int64) {
	if _, ok := s.cfg.PremiumUserIDs[user.ID]; ok {
		return premiumStoragePlanName, premiumUserLimitBytes
	}
	if _, ok := s.cfg.PremiumUserEmails[strings.ToLower(user.Email)]; ok {
		return premiumStoragePlanName, premiumUserLimitBytes
	}
	return freeStoragePlanName, freeUserStorageLimitBytes
}

func (s *server) withAuth(next func(http.ResponseWriter, *http.Request, authUser)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := s.authenticate(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, err.Error())
			return
		}
		next(w, r, user)
	}
}

func (s *server) authenticate(r *http.Request) (authUser, error) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return authUser{}, errors.New("bearer token is required")
	}

	tokenText := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	claims := jwt.MapClaims{}
	token, err := jwt.ParseWithClaims(tokenText, claims, func(token *jwt.Token) (any, error) {
		if token.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %s", token.Header["alg"])
		}
		return []byte(s.cfg.JWTKey), nil
	}, jwt.WithIssuer(s.cfg.JWTIssuer), jwt.WithAudience(s.cfg.JWTAudience))
	if err != nil || !token.Valid {
		return authUser{}, errors.New("invalid token")
	}

	userID := firstClaim(claims, "nameid", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier", "sub")
	if userID == "" {
		return authUser{}, errors.New("token is missing user id")
	}

	return authUser{
		ID:    userID,
		Email: firstClaim(claims, "email", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"),
		Name:  firstClaim(claims, "name", "unique_name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"),
	}, nil
}

func firstClaim(claims jwt.MapClaims, names ...string) string {
	for _, name := range names {
		if value, ok := claims[name].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

func mapDriveFile(file *drive.File) driveFile {
	return driveFile{
		ID:           file.Id,
		Name:         file.Name,
		MimeType:     file.MimeType,
		Size:         file.Size,
		CreatedTime:  parseDriveTime(file.CreatedTime),
		ModifiedTime: parseDriveTime(file.ModifiedTime),
	}
}

func parseDriveTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339, value)
	return parsed
}

func escapeDriveQuery(value string) string {
	return strings.ReplaceAll(value, "'", "\\'")
}

func formatBytes(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	}
	units := []string{"KB", "MB", "GB", "TB"}
	value := float64(bytes)
	for _, unit := range units {
		value = value / 1024
		if value < 1024 || unit == units[len(units)-1] {
			return fmt.Sprintf("%.1f %s", value, unit)
		}
	}
	return fmt.Sprintf("%d B", bytes)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, "%s\n", mustJSON(value))
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeDriveError(w http.ResponseWriter, err error) {
	var googleErr *googleapi.Error
	if errors.As(err, &googleErr) {
		status := googleErr.Code
		if status == 0 {
			status = http.StatusBadGateway
		}
		writeError(w, status, googleErr.Message)
		return
	}
	writeError(w, http.StatusBadGateway, err.Error())
}

func mustJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return `{"error":"failed to encode response"}`
	}
	return string(data)
}

func getenv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func getenvAny(keys []string, fallback string) string {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return fallback
}

func parseCSVSet(value string) map[string]struct{} {
	items := make(map[string]struct{})
	for _, item := range strings.Split(value, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		if item != "" {
			items[item] = struct{}{}
		}
	}
	return items
}

func loadDotEnv(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("could not read %s: %w", path, err)
	}

	for lineNumber, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		name, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("invalid %s line %d", path, lineNumber+1)
		}

		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if name == "" {
			return fmt.Errorf("invalid %s line %d: missing key", path, lineNumber+1)
		}

		os.Setenv(name, value)
	}

	return nil
}
