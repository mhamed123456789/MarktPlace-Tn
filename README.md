# Marketplace TN

Un marketplace tunisien mobile-first construit avec HTML/CSS/JavaScript, FastAPI et Supabase.

La navigation principale est fixée en bas sur mobile et ordinateur. Les vidéos de la découverte se lisent automatiquement, sans son, lorsqu'elles sont visibles. Le bouton Admin reste accessible en haut; l'ouverture du tableau de bord est contrôlée par le rôle administrateur validé par Supabase. Connecte-toi avec le compte admin et son mot de passe habituel. Aucun PIN partagé ou mot de passe administrateur n'est stocké dans le navigateur ou le code.

## Fonctionnalités

- Comptes Supabase Auth; chaque nouveau compte reçoit 2 points.
- Fil photo/vidéo consultable sans compte; connexion obligatoire pour publier, aimer, commenter, sauvegarder, envoyer un message ou gérer son compte.
- Fil photo/vidéo, recherche, catégories, produits/prix, likes, commentaires, favoris et messages privés avec photos et messages vocaux privés.
- Les publications acceptent jusqu'à 6 photos (1 point par photo) ou une vidéo (2 points). Les photos d'un produit défilent horizontalement, avec navigation au toucher et par flèches; chaque image a un aperçu agrandi, zoom et déplacement. Le propriétaire peut modifier les détails ou supprimer le post.
- Les images d'un post sont envoyées en parallèle (jusqu'à 4 fichiers), avec une progression globale. FastAPI relaie les fichiers en flux et conserve un pool de connexions Supabase pour accélérer les envois successifs.
- Publication: 1 point par photo, 2 points par vidéo.
- Offres de recharge: 10 points pour 10 DT, ou 4 points pour 4 DT (de quoi publier 2 photos et 1 vidéo).
- Envoi des photos/vidéos avec une progression réelle; la passerelle FastAPI transmet les fichiers en flux.
- Parcours de recharge en étapes avec le numéro de réception affiché clairement, justificatif privé, suivi dans le profil, validation admin et ajout automatique des points; le refus exige un motif visible par le membre.
- Tableau admin: statistiques exactes des membres, publications, vidéos et paiements, ajustement de points, suspension, demandes et coordonnées D17/Ooredoo/Flouci.
- Règles d'accès appliquées côté base Supabase (RLS); aucune clé `service_role` n'est utilisée.

## Installation locale (Windows)

1. Crée un environnement virtuel et installe les dépendances:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

2. Le fichier `.env` local contient déjà l'URL Supabase et la clé publishable fournies. Pour un autre projet, copie `.env.example` en `.env` et renseigne `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY`.
3. Dans Supabase → **SQL Editor**, exécute tout le contenu de [`supabase/schema.sql`](./supabase/schema.sql). Après une mise à jour du script, exécute-le à nouveau pour appliquer les changements (les coordonnées de paiement par défaut deviennent D17 `90272020` et Ooredoo `90576380`; les valeurs personnalisées ne sont pas écrasées). Les mises à jour incluent les colonnes d'édition et de galerie, le montant en DT des demandes, ainsi que le stockage privé des images et vocaux envoyés en message. Le fil et les commentaires sont visibles publiquement; les données de compte, reçus et pièces jointes restent privées. Tu peux aussi télécharger le script depuis <http://127.0.0.1:8000/setup.sql>. La page d'accueil détecte les anciens schémas et indique qu'une migration est nécessaire.
4. Lance le serveur:

   ```powershell
   uvicorn main:app --reload
   ```

5. Ouvre <http://127.0.0.1:8000>.

La clé publishable est destinée au client. Ne mets jamais une clé `service_role` dans le navigateur ou dans un fichier versionné. Supabase limite l'envoi des e-mails avec son service SMTP par défaut. Pour tester rapidement, ouvre **Authentication → Sign In / Providers → Email** et désactive temporairement **Confirm email**; les nouveaux comptes pourront alors se connecter sans envoyer de message. Pour un déploiement réel, garde la confirmation activée et configure ton propre service dans **Authentication → SMTP Settings**. L'interface affiche le délai de réessai reçu de Supabase et évite les demandes répétées pour la même adresse pendant ce délai.

## Connexion Google

1. Dans Google Cloud Console → **APIs & Services → Credentials**, crée un client OAuth de type **Web application**. Ajoute cette URI de redirection autorisée côté Google:
   `https://pufekqipizaqdxtbwcrl.supabase.co/auth/v1/callback`
2. Dans Supabase → **Authentication → Sign In / Providers → Google**, active Google et configure le **Client ID** et le **Client Secret** depuis Google. Ne mets jamais le secret Google dans le code, le navigateur, `.env`, ni dans Git. Si un secret a été partagé dans une conversation, révoque-le et génère-en un nouveau avant d'activer le fournisseur.
3. Dans Supabase → **Authentication → URL Configuration → Redirect URLs**, autorise `http://127.0.0.1:8000/**` pour le test local. L'application utilise `APP_URL` dans `.env` comme destination après authentification. Sur l'hébergement réel, remplace `APP_URL` par l'URL HTTPS du site et ajoute cette URL à la liste Supabase.
4. Redémarre FastAPI après avoir modifié `.env`; le bouton **Continuer avec Google** échange le code OAuth avec PKCE. Le client secret reste uniquement dans la configuration du fournisseur Supabase.

Si Google affiche `Error 400: redirect_uri_mismatch`, vérifie que l'URI de callback ci-dessus est enregistrée dans **Authorized redirect URIs** pour le même OAuth Client ID que celui configuré dans Supabase. L'erreur se corrige dans Google Cloud Console, pas dans le code de l'application.

Si le retour affiche `Unable to exchange external code`, Google a redirigé vers Supabase mais Supabase n'a pas réussi à valider le code. Vérifie que le Client ID et le Client Secret enregistrés dans le fournisseur Google de Supabase sont tous deux ceux du même client OAuth **Web application**, que le callback est exactement `https://pufekqipizaqdxtbwcrl.supabase.co/auth/v1/callback`, puis enregistre à nouveau le fournisseur. Si le secret a été renouvelé ou exposé, crée-en un nouveau dans Google Cloud et remplace-le dans Supabase. Ne partage pas le secret. Après l'enregistrement, réessaie dans une fenêtre privée.

## Compte déjà créé

Chaque adresse e-mail ne peut créer qu'un compte. Si Supabase répond **User already registered**, l'écran propose directement **Se connecter** avec l'adresse déjà saisie. Si ce compte a été créé via Google, utilise Google après avoir corrigé la configuration de redirection.

## Premier administrateur

Crée un compte dans Marketplace TN, puis exécute cette requête dans le SQL Editor Supabase en remplaçant l'adresse:

```sql
update public.profiles
set is_admin = true
where id = (
  select id from auth.users
  where email = 'admin@example.tn'
);
```

Le bouton Admin du compte non autorisé affiche aussi la requête SQL liée au compte actuellement connecté et permet de vérifier le rôle après son exécution. Reconnecte-toi si nécessaire: l'entrée **Administration** apparaîtra. Les coordonnées de paiement se configurent dans cet espace et sont partagées avec tous les membres. Les reçus sont conservés dans un bucket privé; seuls le propriétaire et les administrateurs autorisés peuvent les consulter.

Les demandes de points sont une vérification manuelle de paiement, pas un encaissement automatique. La valeur en dinars par point doit être communiquée clairement aux acheteurs avant tout paiement.

## API locale

- `GET /api/health` — état du serveur.
- `GET /api/config` — configuration publique Supabase.
- `GET /api/setup-status` — vérifie que le schéma est installé et qu'il est à jour.
- `/api/rest/...` — proxy REST limité aux ressources utilisées par l'application; l'authentification et les politiques RLS Supabase restent actives.
- `/api/storage/upload/...` — envoi de médias/reçus selon les politiques Storage.
- `/api/storage/sign/{bucket}/...` — lien temporaire pour les reçus et pièces jointes privées; les règles Supabase autorisent uniquement le propriétaire, le destinataire de la conversation ou l'admin.
