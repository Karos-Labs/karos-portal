# Allowlisting egress proxy for job sandboxes.
FROM alpine:3.21
RUN apk add --no-cache tinyproxy
# tinyproxy.conf + proxy-filter.txt are mounted at /etc/tinyproxy by compose
EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
