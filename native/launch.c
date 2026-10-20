/* launchd owns the listener; this executable only transfers it across exec.
 * No Node ABI dependency, shell, second daemon, or request replay. */
#include <launch.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 3 || argv[1][0] != '/' || argv[2][0] != '/') {
        fprintf(stderr, "ghpa launcher: expected absolute runtime and entrypoint\n");
        return 64;
    }
    int *fds = NULL;
    size_t count = 0;
    int error = launch_activate_socket("Proxy", &fds, &count);
    if (error || count != 1) {
        fprintf(stderr, "ghpa launcher: socket activation: %s (count=%zu)\n",
                error ? strerror(error) : "expected one listener", count);
        free(fds);
        return 78;
    }
    int fd = fds[0];
    free(fds);
    if (fd != 3) {
        if (dup2(fd, 3) < 0) { perror("ghpa dup2"); return 71; }
        close(fd);
    }
    if (fcntl(3, F_SETFD, 0) < 0 || setenv("GHPA_LAUNCH_FD", "3", 1) < 0) {
        perror("ghpa descriptor setup"); return 71;
    }
    execv(argv[1], argv + 1);
    perror("ghpa exec runtime");
    return 71;
}
