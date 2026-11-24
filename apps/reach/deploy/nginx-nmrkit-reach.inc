# Include inside the HTTPS server for nmrkit.ciqtek.com.
location = /reach {
    if ($host != nmrkit.ciqtek.com) { return 404; }
    return 308 /reach/$is_args$args;
}

location ^~ /reach/downloads/ {
    if ($host != nmrkit.ciqtek.com) { return 404; }
    alias /srv/reach-downloads/;
    autoindex off;
    disable_symlinks on from=/srv/reach-downloads/;
    default_type application/octet-stream;
}

location ^~ /reach/ {
    if ($host != nmrkit.ciqtek.com) { return 404; }
    proxy_pass http://127.0.0.1:18910/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Reach-Client-IP $remote_addr;
    proxy_set_header Cookie "reach_session=$cookie_reach_session";
}
