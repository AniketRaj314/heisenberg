import { timingSafeEqual } from "node:crypto";

export function bearerTokenMatches(authorization, expectedToken) {
  if (!expectedToken || typeof authorization !== "string") return false;
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function requireBearerToken(expectedToken, realm) {
  return (request, response, next) => {
    if (bearerTokenMatches(request.get("authorization"), expectedToken)) {
      return next();
    }
    response.set("WWW-Authenticate", `Bearer realm="${realm}"`);
    return response.status(401).json({
      error: "unauthorized",
      message: "A valid bearer token is required."
    });
  };
}
