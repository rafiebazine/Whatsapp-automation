Here is the overview on the project, and how it is going to operate, with a hard rules to follow.

# 0. Generalities
- The project is desktop applicatoin only using NodeJS and Electron for .exe file generation.
- We will use the Baileys library to manage the sessions and the requests.
- The application will have multiple whatsapp accounts as admin.
- The design of the applicatio will follow and copy the exacty style and colors of whats app.
- The data of the app should be update after exact actions so the app shouldn't operate on outdated data. define these points.
- apply the try catch every where there's a possible error to happen, and handle the errors correctly.
- apply quality measurements like: prevent double clicking on buttons, disable form buttons when a choice clicked...

# 1. User flow
1. Login Page: simple auth with username & password
2. Home Page: it contain a nav bar and body
    a. navbar: it will contain the name of the application + gear icon that takes to the settings page.
    b. body: contains the list of groups manager with the button of add new group.
        - Each item in the list of the groups will have: the group avatar [which is the 1st letter of the name of the group not the actual image of the group] + the name of the group + clock Icon / alert Icon appears conditionally, I will explain for you how it is shown later.
        - By clicking the group item, the user will be transfered to the group page.
3. Group page: it has a nav bar + body.
    a. nav bar contains the group name + a strike Icon that drops down a menu when it is clicked. the menu will have 3 actions: add members / remove member / delete group
    b. body: it contains the list of group member
4. add members page:
    - it will have a button to import from excel at the top. when the list is added, the duplicates numbers aren't shown, and also not send in the request
    - an input field, beside it an add button, this is for the individual adding of members.
    - list of numbers to be added with x icon at the end of each item, when clicked the number is removed of the adding list and the logic also.
    - a button at the that has the text add (<count-of-numbers-added>), when clicked, the numbers are added to the group and the user will land in the page of the group.
    - The adding action will take a time since it will apply delays and round through the admin accounts to avoid bans, so an estimated calculated time will be shown to the user with the updates of remaining time in the group page.
    - in the groups list page, when an action related to this group is on going, the clock icon is shown.
    - if the action fails, the user get's informed, and the error is shown to the user.
    - when the user launches 2 actions or more, he will get 2 status bars or more, and the errors will behave the same.
5. remove members:
    - will behave the same as add new members, with the specificality of the remove page.
    - when a list is added through excel and the numbers doesn't exist in the group, the number is just ignored.
6. when the user clicks delete group:
    - pop-up app will appear with a warning, and a input field to the user inputs the group name to confirm deleting it.
    - it will has the 2 buttons: delete in red + cancel
    - when clicked in delete in red the user waits until the group get's deleted, and then he can leave.
    
7. Settings page: it has a nav bar and a body
    a. nav bar: contians the arrow to go back + name of the page + at the end logout Icon [When clicked, popup will appear so the user confirms logout]
    b. body:
        - a button "Contacts": with an arrow at the end, it leads to the contacts page.
        - Accounts:
            - List of signed in admin accounts.
            - each account item has necessary details + a logout icon at the end [When clicked, popup will appear with the input field to confirm deleting this account from the admins accounts list and 2 buttons: logout + cancel]
            - a buttons with Add new admin that shows the Qr code to scan to add a new account.
                - when new account is added, it is automatically assigned as an admin for all existing groups.
                - for the algorithm of rounding between accounts and delays, suggest once for me, and I will confirm it.
8. Contacts page: Has the list of all contacts with their names an phone numbers....
