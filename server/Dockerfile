FROM gradle:8.14.3-jdk21 AS build
WORKDIR /src
COPY . .
RUN gradle --no-daemon :server:installDist

FROM eclipse-temurin:21-jre
ENV HOST=0.0.0.0
ENV PORT=8080
ENV NOTES_DB_PATH=/data/inknote.db
VOLUME ["/data"]
COPY --from=build /src/server/build/install/server /app
EXPOSE 8080
ENTRYPOINT ["/app/bin/server"]
