# Minimal production-ish container for the Go API
FROM golang:1.22 AS build
WORKDIR /src
COPY . .
RUN go mod download
RUN CGO_ENABLED=0 go build -o /out/api ./cmd/api

FROM gcr.io/distroless/base-debian12
WORKDIR /app
COPY --from=build /out/api /app/api
ENV HOLO_API_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["/app/api"]
