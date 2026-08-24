FROM eclipse-temurin:25-jre

ARG GRAPHHOPPER_VERSION=11.0
WORKDIR /opt/graphhopper

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl python3 python3-pyosmium \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --retry 3 \
      --output graphhopper-web.jar \
      "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GRAPHHOPPER_VERSION}/graphhopper-web-${GRAPHHOPPER_VERSION}.jar"

WORKDIR /app
COPY . /app
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8989 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]
