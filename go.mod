module github.com/LangSensei/swat-dashboard

go 1.24.1

require (
	github.com/creack/pty v1.1.24
	github.com/gorilla/websocket v1.5.3
)

require (
	github.com/LangSensei/swat v0.0.0
	github.com/UserExistsError/conpty v0.1.4
	golang.org/x/sys v0.37.0 // indirect
)

replace github.com/LangSensei/swat => /tmp/swat
