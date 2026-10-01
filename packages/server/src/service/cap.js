// Verify a single-use token against a Cap Standalone site endpoint.
module.exports = async ({ endpoint, secret, token }) => {
  if (!endpoint || !secret || typeof token !== 'string' || !token) return false;

  try {
    const response = await fetch(`${endpoint.replace(/\/+$/u, '')}/siteverify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok && (await response.json()).success === true;
  } catch {
    return false;
  }
};
