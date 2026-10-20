// Site settings. All of these are safe to publish: the Supabase anon key is limited by the
// database's row-level security, and Spotify/Last.fm keys here are public client IDs.
// Leave supabaseUrl empty to run the site on built-in sample listings.
window.SLC_CONFIG = {
  siteName: "Music in SLC",
  supabaseUrl: "https://bamrbmxakgdhczzcprzt.supabase.co",
  // Project Settings > API Keys > Legacy > anon public (safe to publish; row-level security limits it)
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbXJibXhha2dkaGN6emNwcnp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NDM2NTQsImV4cCI6MjEwODAxOTY1NH0.eiPXcfVrMY0aYxWKKSgXiLmoEibeyllXtM3Q9X6FWIo",
  spotifyClientId: "",      // developer.spotify.com dashboard; add this site's URL as a Redirect URI
  lastfmApiKey: "",         // last.fm/api/account/create (free)
  inboxAddress: "musicinslc@gmail.com",
};
