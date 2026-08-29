# Configurar acceso SSH de GitHub de solo lectura en PythonAnywhere

Utilice una deploy key dedicada y de solo lectura de GitHub para que el clon de PythonAnywhere correctamente configurado pueda ejecutar `git pull` desde este repositorio privado. Esto es más seguro que hacer público el repositorio temporalmente: evita la exposición pública y concede al servidor únicamente el acceso de lectura al repositorio que necesita.

## Alcance y supuestos

- Ejecute estos comandos en una consola Bash de PythonAnywhere con la cuenta propietaria del clon de despliegue.
- El clon de destino ya está correctamente configurado para la aplicación web. No suponga un nombre de directorio ni modifique la configuración de WSGI.
- `origin` usa HTTPS actualmente y debe pasar a ser `git@github-accesorios:AndresQ-Dev/accesorios.git`.
- Las deploy keys tienen alcance por repositorio. Utilice un par de claves dedicado para este repositorio; no lo reutilice en otro repositorio.

> [!WARNING]
> La clave privada debe permanecer exclusivamente en PythonAnywhere. Nunca la copie a GitHub, la incluya en un commit, la pegue en un ticket ni la exponga de ninguna otra forma. Solo se agrega a GitHub el archivo `.pub`.

## Ruta rápida

1. Genere y proteja un par de claves `ed25519` dedicado.
2. Agregue un alias de host SSH específico del repositorio que seleccione esa clave sin reemplazar la configuración SSH existente.
3. Agregue la clave pública en **Settings** > **Deploy keys** del repositorio de GitHub y mantenga deshabilitado el acceso de escritura.
4. Cambie `origin` a la URL SSH con alias, verifique el acceso SSH a GitHub y actualice con protección exclusiva de avance rápido.

## Generar la clave en PythonAnywhere

Ejecute los siguientes comandos. La protección evita reemplazar una clave existente con el mismo nombre.

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
test ! -e ~/.ssh/accesorios_github_deploy || {
  echo "~/.ssh/accesorios_github_deploy already exists; choose a different dedicated filename."
  exit 1
}
ssh-keygen -t ed25519 -C "pythonanywhere-accesorios-deploy" -f ~/.ssh/accesorios_github_deploy
chmod 600 ~/.ssh/accesorios_github_deploy
chmod 644 ~/.ssh/accesorios_github_deploy.pub
cat ~/.ssh/accesorios_github_deploy.pub
```

Utilice una frase de contraseña solo si el flujo de despliegue puede proporcionarla de forma segura al actualizar. Copie la única línea de la clave pública que imprime el último comando; no copie el archivo de clave privada.

## Configurar el alias SSH específico del repositorio

El nombre de archivo de clave no predeterminado no se selecciona automáticamente. Si `~/.ssh/config` no existe, créelo con este alias:

```bash
test ! -e ~/.ssh/config || {
  echo "~/.ssh/config already exists; preserve it and add the alias manually."
  exit 1
fi
cat > ~/.ssh/config <<'EOF'
Host github-accesorios
  HostName github.com
  User git
  IdentityFile ~/.ssh/accesorios_github_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

Si `~/.ssh/config` ya existe, no lo reemplace. Agregue el mismo bloque al comienzo de ese archivo, antes de cualquier bloque `Host *`, y luego ejecute `chmod 600 ~/.ssh/config`. Esto conserva la configuración existente y garantiza que el alias seleccione esta clave.

## Agregar la clave pública a GitHub

1. Abra el repositorio `AndresQ-Dev/accesorios` en GitHub.
2. Acceda a **Settings** > **Deploy keys** > **Add deploy key**.
3. Utilice un título reconocible, como `PythonAnywhere read-only deploy`.
4. Pegue el contenido de `~/.ssh/accesorios_github_deploy.pub` en **Key**.
5. Deje sin marcar **Allow write access** y agregue la clave.

Las deploy keys de GitHub son de solo lectura de forma predeterminada y conceden acceso a un único repositorio. Consulte [Managing deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys) de GitHub.

## Cambiar el clon configurado a SSH y actualizar

En el clon de despliegue configurado, inspeccione el remoto actual y reemplace exactamente su URL HTTPS:

```bash
git remote -v
git remote set-url origin git@github-accesorios:AndresQ-Dev/accesorios.git
git remote -v
```

Verifique la primera conexión SSH antes de actualizar:

```bash
ssh -T git@github-accesorios
```

En la primera conexión, compare la huella digital del host mostrada con las [huellas digitales de claves SSH publicadas por GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints). Escriba `yes` solo si coinciden; SSH registrará entonces GitHub en `~/.ssh/known_hosts`. Se espera un mensaje de autenticación exitosa aunque este comando pueda finalizar con el estado `1`, porque GitHub no proporciona acceso de shell. Consulte [Testing your SSH connection](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/testing-your-ssh-connection).

Luego actualice el clon sin permitir un commit de fusión:

```bash
git pull --ff-only
```

## Solución de problemas

| Síntoma | Verificación y resolución |
|---|---|
| `Permission denied (publickey)` | Confirme que se agregó la clave pública, no la privada, como deploy key de este repositorio; asegúrese de que la clave privada y `~/.ssh/config` tengan el modo `600`, el directorio `.ssh` tenga el modo `700`, y el alias `github-accesorios` incluya `IdentityFile ~/.ssh/accesorios_github_deploy` e `IdentitiesOnly yes`. Vuelva a intentar `ssh -T git@github-accesorios`. |
| La actualización llega al repositorio incorrecto o aún solicita credenciales HTTPS | Ejecute `git remote -v`. Las URL de obtención y envío de `origin` deben ser `git@github-accesorios:AndresQ-Dev/accesorios.git`; si es necesario, ejecute nuevamente `git remote set-url origin git@github-accesorios:AndresQ-Dev/accesorios.git`. |
| La primera conexión solicita confirmar `github.com` | Verifique la huella digital mostrada con las huellas publicadas por GitHub y luego escriba `yes` para crear la entrada de `known_hosts`. No acepte una huella digital sin verificar ni desactive la comprobación de claves del host. |

Para conocer el comportamiento de los remotos de Git, consulte [Managing remote repositories](https://docs.github.com/en/get-started/git-basics/managing-remote-repositories) de GitHub.

## Rotación y revocación

Para rotar la clave, cree una nueva clave dedicada con un nombre de archivo nuevo, agregue su clave pública como una nueva deploy key de solo lectura, actualice `IdentityFile` del alias existente, verifique `ssh -T git@github-accesorios` y `git pull --ff-only`, luego elimine la deploy key anterior en GitHub y elimine de forma segura sus archivos de clave privada y pública de PythonAnywhere. Para revocar inmediatamente el acceso del servidor, elimine la deploy key en GitHub; también elimine los archivos de clave locales cuando el servidor ya no los necesite.

## Lista de verificación

- [ ] El par de claves se generó en PythonAnywhere con `ed25519` y permisos restrictivos.
- [ ] Solo se agregó la clave `.pub` en **Settings** > **Deploy keys** del repositorio de GitHub.
- [ ] **Allow write access** está deshabilitado.
- [ ] La clave está dedicada a `AndresQ-Dev/accesorios` y no se usa en otro repositorio.
- [ ] `~/.ssh/config` tiene el modo `600` y el alias `github-accesorios` selecciona únicamente `~/.ssh/accesorios_github_deploy`.
- [ ] Las URL de obtención y envío de `origin` son `git@github-accesorios:AndresQ-Dev/accesorios.git`.
- [ ] La huella digital del host de GitHub se verificó antes de aceptar la primera conexión.
- [ ] `git pull --ff-only` se ejecuta correctamente en el clon de despliegue correctamente configurado.
