module.exports = {
  apps: [{
    name:           "vistax",
    script:         "server.js",
    cwd:            "C:\\VistaX-Core\\",
    autorestart:    true,
    max_restarts:   10,
    min_uptime:     5000,
    restart_delay:  5000,
    error_file:     "C:\\AgroParallel\\logs\\vistax-error.log",
    out_file:       "C:\\AgroParallel\\logs\\vistax-out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs:     true,
    node_args:      "--max-old-space-size=512",
    env: {
      NODE_ENV:    "production",
      PORT:        3001,
      MQTT_BROKER: "mqtt://127.0.0.1:1883",
    },
  }],
};
